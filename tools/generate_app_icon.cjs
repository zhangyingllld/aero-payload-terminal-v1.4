#!/usr/bin/env node
// Optional artwork build: SVG remains editable; app builds use the checked-in PNG.
// node tools/generate_app_icon.cjs PATH_TO_SHARP_MODULE
const fs = require('node:fs');
const path = require('node:path');
const sharp = require(process.argv[2] || 'sharp');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'payload-app/design/app_icon.svg');
const output = path.join(root, 'payload-app/AppScope/resources/base/media/app_icon.png');
sharp(fs.readFileSync(source), { density: 384 }).resize(512,512).png().toFile(output)
  .then(() => console.log('Generated 512x512 launcher and header icon: ' + output))
  .catch(error => { console.error(error); process.exitCode=1; });
