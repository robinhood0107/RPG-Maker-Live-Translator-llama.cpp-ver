#!/bin/bash

echo -e "\033[32mInstalling Text Replacement Addon...\033[0m"

# Check and fix name field in both package.json and www/package.json
handled_any=false
for PKG_PATH in "package.json" "www/package.json"; do
  if [ ! -f "$PKG_PATH" ]; then
    continue
  fi
  handled_any=true
  if grep -q '"name"[[:space:]]*:[[:space:]]*""' "$PKG_PATH" 2>/dev/null; then
      echo -e "\033[33mFound empty name field in $PKG_PATH, setting to 'Game'\033[0m"
      sed -i.backup 's/"name"[[:space:]]*:[[:space:]]*""/"name": "Game"/' "$PKG_PATH"
      echo -e "\033[32mUpdated name field to 'Game' in $PKG_PATH\033[0m"
  elif grep -q '"name"[[:space:]]*:' "$PKG_PATH" 2>/dev/null; then
      NAME_VALUE=$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$PKG_PATH" | sed 's/.*"\([^"]*\)".*/\1/')
      echo -e "\033[36m$PKG_PATH name field is already set to: '$NAME_VALUE'\033[0m"
  else
      echo -e "\033[33mNo name field found in $PKG_PATH (leaving file unchanged)\033[0m"
  fi
done

if [ "$handled_any" = false ]; then
  echo -e "\033[33mpackage.json not found - this is normal for some RPG Maker versions\033[0m"
fi

# Detect folder structure
PLUGINS_DIR=""
PLUGINS_FILE=""

if [ -d "www/js/plugins" ]; then
    PLUGINS_DIR="www/js/plugins"
    PLUGINS_FILE="www/js/plugins.js"
    echo -e "\033[36mDetected www/js/plugins folder structure\033[0m"
elif [ -d "js/plugins" ]; then
    PLUGINS_DIR="js/plugins"
    PLUGINS_FILE="js/plugins.js"
    echo -e "\033[36mDetected js/plugins folder structure\033[0m"
else
    echo -e "\033[31mError: Could not find js/plugins or www/js/plugins directory\033[0m"
    echo -e "\033[33mPlease run this installer from your RPG Maker game's root directory\033[0m"
    exit 1
fi

# Copy the JavaScript file to the plugins directory
if [ -f "text-replacement-addon.js" ]; then
    cp "text-replacement-addon.js" "$PLUGINS_DIR/text-replacement-addon.js"
    echo -e "\033[33mPlugin file copied successfully to $PLUGINS_DIR\033[0m"
else
    echo -e "\033[31mError: text-replacement-addon.js not found\033[0m"
    exit 1
fi

# Check if the plugin entry already exists in plugins.js
if [ -f "$PLUGINS_FILE" ]; then
    if grep -q "text-replacement-addon" "$PLUGINS_FILE"; then
        echo -e "\033[33mPlugin entry already exists in $PLUGINS_FILE\033[0m"
    else
        echo -e "\033[33mAdding plugin entry to $PLUGINS_FILE...\033[0m"
        
        # Create a backup
        cp "$PLUGINS_FILE" "$PLUGINS_FILE.backup"
        echo -e "\033[36mBackup created: $PLUGINS_FILE.backup\033[0m"
        
        # Process file line by line, only modifying the [ line
        awk '
        BEGIN { found = 0 }
        {
            if (!found && $0 == "[") {
                print "[{\"name\":\"text-replacement-addon\",\"status\":true,\"description\":\"Text replacement addon for NW.js apps - extracts and modifies all viewport text\",\"parameters\":{}},"
                found = 1
            } else {
                print $0
            }
        }
        ' "$PLUGINS_FILE" > "$PLUGINS_FILE.tmp" && mv "$PLUGINS_FILE.tmp" "$PLUGINS_FILE"
        
        echo -e "\033[32mPlugin entry added to $PLUGINS_FILE\033[0m"
    fi
else
    echo -e "\033[31mError: $PLUGINS_FILE not found\033[0m"
    exit 1
fi

echo -e "\033[32mText Replacement Addon installed successfully!\033[0m"
echo -e "\033[36mA backup of the original plugins.js was created as plugins.js.backup\033[0m"
