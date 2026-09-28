from unittest.mock import AsyncMock, patch
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from homeassistant.config_entries import SOURCE_USER
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.const import STATE_UNAVAILABLE
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.tucor_2core.const import DOMAIN
from custom_components.tucor_2core.api import BridgeAuthError, BridgeClient, BridgeError
from custom_components.tucor_2core.weather import rain_measurement, forecast_rain, collect_weather

STATE = {'apiVersion':1,'mode':'demo','controlEnabled':True,'available':True,
         'controller':{'id':2479,'name':'Garden simulator','type':'LTD'},
         'zones':[{'id':'1','name':'Rear Lawn','configured':True,'running':False,'owned':False,'endsAt':None},
                  {'id':'2','name':'ST2','configured':False,'running':False,'owned':False,'endsAt':None}],
         'status':{'voltageV':34.9,'current':19,'rainShutDown':0},
         'policy':{'mode':'observe'},'weatherDecision':None,'observedAt':'2026-09-27T12:00:00+00:00'}

@pytest.fixture
def client():
    with patch('custom_components.tucor_2core.api.BridgeClient.state',new=AsyncMock(return_value=deepcopy(STATE))) as state, patch('custom_components.tucor_2core.api.BridgeClient.request',new=AsyncMock(return_value={'ok':True})) as request:
        yield state, request

async def setup_entry(hass):
    entry=MockConfigEntry(domain=DOMAIN,data={'url':'http://bridge.local:8787','api_key':'test-key'},options={'default_minutes':5},title='2core',unique_id='demo',version=1)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry

async def test_setup_entities_and_services(hass,client):
    entry=await setup_entry(hass)
    valve=hass.states.get('valve.garden_simulator_rear_lawn')
    assert valve and valve.state=='closed'
    assert hass.states.get('valve.garden_simulator_st2') is None  # unused slot disabled
    assert hass.states.get('sensor.garden_simulator_voltage').state=='34.9'
    await hass.services.async_call('valve','open_valve',{'entity_id':valve.entity_id},blocking=True)
    client[1].assert_called_with('/zones/1/start',{'minutes':5})
    await hass.services.async_call(DOMAIN,'start_zone',{'config_entry_id':entry.entry_id,'zone':1,'minutes':60},blocking=True)
    client[1].assert_called_with('/zones/1/start',{'minutes':60})
    await hass.services.async_call(DOMAIN,'stop_my_watering',{'config_entry_id':entry.entry_id},blocking=True)
    client[1].assert_called_with('/stop',{})
    await hass.services.async_call('select','select_option',{'entity_id':'select.garden_simulator_weather_mode','option':'automatic'},blocking=True)
    client[1].assert_called_with('/policy',{'mode':'automatic'})
    await hass.services.async_call('number','set_value',{'entity_id':'number.garden_simulator_rain_delay','value':12},blocking=True)
    client[1].assert_called_with('/rain',{'hours':12})
    client[0].return_value={**deepcopy(STATE),'available':False}
    await entry.runtime_data.async_refresh()
    await hass.async_block_till_done()
    assert hass.states.get(valve.entity_id).state==STATE_UNAVAILABLE
    assert await hass.config_entries.async_unload(entry.entry_id)

async def test_config_and_options_flow(hass,client):
    with patch('custom_components.tucor_2core.async_setup_entry',return_value=True):
        result=await hass.config_entries.flow.async_init(DOMAIN,context={'source':SOURCE_USER})
        assert result['type']==FlowResultType.FORM
        client[0].side_effect=BridgeAuthError('bad key')
        result=await hass.config_entries.flow.async_configure(result['flow_id'],{'url':'http://bridge.local','api_key':'wrong'})
        assert result['errors']=={'base':'invalid_auth'}
        client[0].side_effect=None
        result=await hass.config_entries.flow.async_configure(result['flow_id'],{'url':'http://bridge.local/','api_key':'right'})
        assert result['type']==FlowResultType.CREATE_ENTRY
        assert result['data']['url']=='http://bridge.local'
        entry=result['result']
        options=await hass.config_entries.options.async_init(entry.entry_id)
        assert options['type']==FlowResultType.FORM
        result=await hass.config_entries.options.async_configure(options['flow_id'],{'default_minutes':1,'intensity_entity':'sensor.tempest_rain'})
        assert result['type']==FlowResultType.CREATE_ENTRY
        assert entry.options['intensity_entity']=='sensor.tempest_rain'

async def test_empty_controller_stays_in_setup(hass,client):
    client[0].return_value={**STATE,'controller':None,'zones':[]}
    result=await hass.config_entries.flow.async_init(DOMAIN,context={'source':SOURCE_USER},data={'url':'http://bridge.local','api_key':'key'})
    assert result['errors']=={'base':'cannot_connect'}

async def test_native_weather_normalization_and_optional_inputs(hass):
    assert await collect_weather(hass,{}) is None
    hass.states.async_set('sensor.rain','0.1',{'unit_of_measurement':'in/h'})
    sample=await collect_weather(hass,{'intensity_entity':'sensor.rain'})
    assert sample['intensityMmH']==pytest.approx(2.54)
    hass.states.async_set('sensor.rain','unavailable',{'unit_of_measurement':'in/h'})
    assert await collect_weather(hass,{'intensity_entity':'sensor.rain'}) is None

@pytest.mark.parametrize('value,unit,age,expected',[('0.1','in/h',0,2.54),('1','mm/h',0,1),('1','mm/h',1900,None),('unknown','mm/h',0,None),('nan','mm/h',0,None),('-1','mm/h',0,None),('1','liters',0,None)])
def test_measurements(value,unit,age,expected):
    now=datetime.now(timezone.utc)
    state=SimpleNamespace(state=value,attributes={'unit_of_measurement':unit},last_reported=now-timedelta(seconds=age))
    actual=rain_measurement(state,True,now)
    assert actual==pytest.approx(expected) if expected is not None else actual is None

def test_forecast_requires_complete_probability_and_units():
    now=datetime(2026,9,27,12,tzinfo=timezone.utc)
    rows=[{'datetime':(now+timedelta(hours=h)).isoformat(),'precipitation':.1,'precipitation_probability':80} for h in range(12)]
    assert forecast_rain(rows,'in',now)['forecastMm']==pytest.approx(30.48)
    assert forecast_rain(rows[:-1],'in',now) is None
    assert forecast_rain(rows,'unknown',now) is None
    del rows[0]['precipitation_probability']
    assert forecast_rain(rows,'mm',now) is None

async def test_weather_coordinator_sends_observations(hass,client):
    entry=await setup_entry(hass)
    sample={'observedAt':datetime.now(timezone.utc).isoformat(),'intensityMmH':2}
    with patch('custom_components.tucor_2core.coordinator.collect_weather',new=AsyncMock(return_value=sample)):
        await entry.runtime_data.weather_tick(None)
    client[1].assert_called_with('/weather',sample)
