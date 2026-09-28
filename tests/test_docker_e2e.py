"""Opt-in test against an isolated simulator, never a real controller."""
import os
import pytest
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from pytest_homeassistant_custom_component.common import MockConfigEntry
from custom_components.tucor_2core.api import BridgeClient
from custom_components.tucor_2core.const import DOMAIN

@pytest.mark.skipif(not os.environ.get('TWOCORE_TEST_URL'),reason='Set TWOCORE_TEST_URL to an isolated demo server')
async def test_home_assistant_to_docker_simulator(hass, socket_enabled):
    url=os.environ['TWOCORE_TEST_URL']
    client=BridgeClient(async_get_clientsession(hass),url,'2core-demo')
    state=await client.state()
    assert state['mode']=='demo', 'Refusing to test writes against a live controller'
    entry=MockConfigEntry(domain=DOMAIN,data={'url':url,'api_key':'2core-demo'},options={'default_minutes':1,'intensity_entity':'sensor.test_tempest_rain'},title='2core',unique_id='isolated-demo',version=1)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    try:
        await hass.services.async_call(DOMAIN,'start_zone',{'config_entry_id':entry.entry_id,'zone':2,'minutes':1},blocking=True)
        state=await client.state()
        zone=next(z for z in state['zones'] if z['id']=='2')
        assert zone['running'] and zone['owned'] and zone['endsAt']
        await hass.services.async_call(DOMAIN,'stop_my_watering',{'config_entry_id':entry.entry_id},blocking=True)
        assert not any(z['running'] for z in (await client.state())['zones'])
        await hass.services.async_call('select','select_option',{'entity_id':'select.garden_simulator_weather_mode','option':'automatic'},blocking=True)
        await entry.runtime_data.async_refresh()
        hass.states.async_set('sensor.test_tempest_rain','0.1',{'unit_of_measurement':'in/h'})
        await entry.runtime_data.weather_tick(None)
        state=await client.state()
        assert state['weatherDecision']['applied']
        assert state['status']['rainShutDown']>11*3600
    finally:
        await client.request('/stop',{})
        await client.request('/rain',{'hours':0})
        await client.request('/policy',{'mode':'observe'})
        await hass.config_entries.async_unload(entry.entry_id)
