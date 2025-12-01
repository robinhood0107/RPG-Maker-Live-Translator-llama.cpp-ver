This is a translation plugin for RPG Maker MV/MZ. The goal is to translate all text that appears on the screen.

# Project Installation
Two layers of installation exist. Outer (development environment): .vscode/ adds configurations for installing all relevant files to experimentation/ directory, which is the starting point for inner installer (user facing) and executing the inner installer. Inner: User installers (install executes installer.ps1 or installer.sh) take over and copy the files and edit configurations as needed.

# Project status and short term goals
The plugin kind of works, but lack of code organization hinders further progress. You are currently helping clean up and refactor the project.

# Rules
Do not modify anything inside experimentation/ directly, as this is our run environment. You may only modify the files outside experimentation/.
Temporarily focus on Windows installer paths; ignore macOS/Linux installers unless the task explicitly requires them.
