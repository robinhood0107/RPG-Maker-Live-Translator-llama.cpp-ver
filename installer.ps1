Write-Host "Installing Text Replacement Addon..." -ForegroundColor Green

# Check and fix name field in both package.json and www\package.json (non-destructive)
$packagePaths = @("package.json", "www\package.json")
$foundAny = $false

foreach ($packagePath in $packagePaths) {
    if (-not (Test-Path $packagePath)) { continue }
    $foundAny = $true
    try {
        $packageContent = Get-Content $packagePath -Raw -Encoding UTF8
        $packageJson = $packageContent | ConvertFrom-Json

        $hasNameProperty = ($null -ne ($packageJson.PSObject.Properties["name"]))
        $currentName = if ($hasNameProperty) { [string]$packageJson.name } else { $null }

        if ($hasNameProperty -and $currentName -ne $null -and $currentName.Trim() -eq "") {
            Write-Host "Found empty name field in $packagePath, setting to 'Game'" -ForegroundColor Yellow

            $backupPath = "$packagePath.backup"
            if (-not (Test-Path $backupPath)) {
                Copy-Item $packagePath $backupPath
                Write-Host "Backup created: $backupPath" -ForegroundColor Cyan
            }

            $updatedContent = $packageContent -replace '("name"\s*:\s*)""', '$1"Game"'
            Set-Content -LiteralPath $packagePath -Value $updatedContent -Encoding UTF8 -Force
            Write-Host "Updated name field to 'Game' in $packagePath" -ForegroundColor Green
        } elseif ($hasNameProperty -and -not [string]::IsNullOrWhiteSpace($currentName)) {
            Write-Host "$packagePath name field is already set to: '$currentName'" -ForegroundColor Cyan
        } else {
            Write-Host "No empty name field found in $packagePath (leaving file unchanged)" -ForegroundColor Cyan
        }
    } catch {
        Write-Host "Warning: Could not process ${packagePath}: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

if (-not $foundAny) {
    Write-Host "package.json not found - this is normal for some RPG Maker versions" -ForegroundColor Yellow
}

# Detect folder structure
$pluginsDir = ""
$pluginsFile = ""

if (Test-Path "www\js\plugins") {
    $pluginsDir = "www\js\plugins"
    $pluginsFile = "www\js\plugins.js"
    Write-Host "Detected www\js\plugins folder structure" -ForegroundColor Cyan
} elseif (Test-Path "js\plugins") {
    $pluginsDir = "js\plugins"
    $pluginsFile = "js\plugins.js"
    Write-Host "Detected js\plugins folder structure" -ForegroundColor Cyan
} else {
    Write-Host "Error: Could not find js\plugins or www\js\plugins directory" -ForegroundColor Red
    Write-Host "Please run this installer from your RPG Maker game's root directory" -ForegroundColor Yellow
    exit 1
}

# Copy the JavaScript file to the plugins directory
if (Test-Path "text-replacement-addon.js") {
    Copy-Item "text-replacement-addon.js" "$pluginsDir\text-replacement-addon.js" -Force
    Write-Host "Plugin file copied successfully to $pluginsDir" -ForegroundColor Yellow
} else {
    Write-Host "Error: text-replacement-addon.js not found" -ForegroundColor Red
    exit 1
}

# Check if the plugin entry already exists in plugins.js
if (Test-Path $pluginsFile) {
    $pluginsContent = Get-Content $pluginsFile -Raw
    if ($pluginsContent -match "text-replacement-addon") {
        Write-Host "Plugin entry already exists in $pluginsFile" -ForegroundColor Yellow
    } else {
        Write-Host "Adding plugin entry to $pluginsFile..." -ForegroundColor Yellow
        
        # Create a backup
        Copy-Item $pluginsFile "$pluginsFile.backup" -Force
        Write-Host "Backup created: $pluginsFile.backup" -ForegroundColor Cyan
        
        # Process file line by line, only modifying the [ line
        $lines = Get-Content $pluginsFile -Encoding UTF8
        $newLines = @()
        $found = $false
        
        foreach ($line in $lines) {
            if (!$found -and $line -eq '[') {
                $newLines += '[{"name":"text-replacement-addon","status":true,"description":"Text replacement addon for NW.js apps - extracts and modifies all viewport text","parameters":{}},'
                $found = $true
            } else {
                $newLines += $line
            }
        }
        
        $newLines | Set-Content $pluginsFile -Encoding UTF8 -Force
        Write-Host "Plugin entry added to $pluginsFile" -ForegroundColor Green
    }
} else {
    Write-Host "Error: $pluginsFile not found" -ForegroundColor Red
    exit 1
}

Write-Host "Text Replacement Addon installed successfully!" -ForegroundColor Green
Write-Host "A backup of the original plugins.js was created as plugins.js.backup" -ForegroundColor Cyan
