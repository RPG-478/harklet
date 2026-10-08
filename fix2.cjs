const fs = require('fs');
const p = 'C:\\Users\\aiueo\\harklet\\src\\index.js';
const lines = fs.readFileSync(p, 'utf8').split('\n');
lines[42] = "      { name: 'model', value: '\`' + (s.model || config.llm.model) + '\`', inline: true },";
fs.writeFileSync(p, lines.join('\n'));
console.log(JSON.stringify(lines[42]));

