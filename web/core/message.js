// The status banner under the header, mirrored in the zone sheet.
import { $ } from './dom.js';
import { context } from './app.js';
import { pendingCommand } from '../model/zones.js';

let timer;
/** Shows a status line. Confirmations fade on their own; errors stay until replaced. */
export function message(text, error = false) {
  clearTimeout(timer);
  $('message').hidden = !text;
  $('message').textContent = text;
  $('message').className = error ? 'error' : '';
  $('sheet-feedback').textContent = text;
  $('sheet-feedback').className = error ? 'failure' : '';
  const waiting = () => Boolean(pendingCommand(context()));
  if (text && !error && !waiting())
    timer = setTimeout(() => {
      if (!waiting()) message('');
    }, 6000);
}
