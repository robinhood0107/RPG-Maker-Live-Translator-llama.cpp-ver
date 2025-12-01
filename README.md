## Overview
RPG Maker MV / MZ addon to translate all text that gets drawn on the screen. You must provide your own DeepL API key.

Since RPG Maker is a scriptable platform, no implementation of a translator will work against every game. Chances are that many games will have subtle issues or won't work at all unless you debug (fix this script) yourself.

## Implementation
1. Tries to detect all kinds of texts being drawn on the screen and read its contents.
2. Asynchronously query translation.
3. When translations arrive, clear the corresponding text.
4. Draw the translation in its place with invisible unicode watermarks so that the process does not repeat. 
- This addon shouldn't affect the game's logic in any way. 
- As a failsafe for custom draw implementations, there is a bitmap level detection which may or may not work. Disable if you're having problems.

## Prerequisites:
1. If the game is packed with Enigma Virtual Box, unpack it first.
2. (Required for some games) Update the game's included nw.js library. All RPGMV/MZ games ship with nwjs installations - sometimes with very outdated ones that will not work with this addon. https://nwjs.io/downloads/ - Extract all files to the game directory (where Game.exe is) and change the name of nwjs.exe to Game.exe. 

## Instructions (Installer):
1. Download all files (excluding .vscode files) and unzip to the game folder.
2. Create apikey.txt containing your DeepL API key.
3. Right-click `installer.ps1` → `Run with PowerShell`. If blocked, open up powershell console and `Set-ExecutionPolicy -Scope Process Bypass`. If you're confused, ask ChatGPT to guide you through with executing a `ps1` powershell script.
4. Open up translator.js with your notepad and change `SETTINGS.translation.targetLang` (such as EN).

## Instructions (Manual):
1. Copy `text-replacement-addon.js` to `js/plugins/` folder and add an entry to `plugins.js` file.
2. Inspect `package.json` and make sure `name` field is not empty.
3. Open up translator.js with your notepad and change `SETTINGS.translation.targetLang` to the language of your choice (like `EN`).

## DeepL API
Change the endpoint to `api.deepl.com` if you're a paid user.

## Dev Environment and Troubleshooting:
1. Install `nwjs debugger for VSCode` plugin - https://marketplace.visualstudio.com/items?itemName=ruakr.vsc-nwjs
2. Put the game inside `experimentation/` folder.
3. Use included `launch.json` configurations to launch nwjs debugging session.
4. Open up your vibecodingpromasterTM software of your choice because surely you're not manually debugging this 2000 line jank like what, some kind of a caveman.

![License](https://img.shields.io/badge/License-CC%20BY%204.0-blue.svg)