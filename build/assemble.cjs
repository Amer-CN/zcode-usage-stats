const fs = require('fs');
const path = require('path');
const body = fs.readFileSync(path.join(__dirname, 'body.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'panel.css'), 'utf8');
if (!body.includes('__CSS__')) { console.error('no placeholder'); process.exit(1); }
const BS = String.fromCharCode(92); // backslash
const safe = css
  .split(BS).join(BS + BS)
  .split('`').join(BS + '`')
  .split('${').join(BS + '${');
const out = body.replace('__CSS__', safe);
fs.writeFileSync(path.join(__dirname, 'client.new.js'), out, 'utf8');
console.log('assembled bytes:', out.length);
