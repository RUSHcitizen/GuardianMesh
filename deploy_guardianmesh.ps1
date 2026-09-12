param(
    # Public Worker URL for the smoke tests, e.g. https://guardianmesh.<subdomain>.workers.dev
    [string]$PublicUrl = $env:GUARDIANMESH_PUBLIC_URL,
    # Commit and push local changes before deploying
    [switch]$Commit
)

# GuardianMesh deploy: validates and deploys the code exactly as it is in the repo.
# It never rewrites source files (an earlier version regenerated config.js/worker.js
# from embedded copies, which silently reverted fixes and corrupted UTF-8 text).

$ErrorActionPreference = "Stop"

if (-not (Test-Path ".\wrangler.toml") -or -not (Test-Path ".\frontend\index.html")) {
    throw "Run this script from the GuardianMesh repository root."
}

Write-Host "Checking JavaScript syntax..." -ForegroundColor Cyan
Get-ChildItem .\frontend\js\*.js, .\frontend\data\*.js, .\worker.js | ForEach-Object {
    node --check $_.FullName
    if ($LASTEXITCODE -ne 0) { throw "Syntax error in $($_.Name)" }
}

Write-Host "Validating Worker bundle with Wrangler..." -ForegroundColor Cyan
npx wrangler deploy --dry-run
if ($LASTEXITCODE -ne 0) { throw "wrangler dry run failed" }

if ($Commit) {
    git add -A
    git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        git commit -m "Deploy GuardianMesh"
        git push -u origin (git branch --show-current).Trim()
    } else {
        Write-Host "No new git changes to commit."
    }
}

# Secrets are optional; upload only what is available locally.
if ($env:GOOGLE_MAPS_API_KEY) {
    Write-Host "Uploading GOOGLE_MAPS_API_KEY secret..." -ForegroundColor Cyan
    Write-Output $env:GOOGLE_MAPS_API_KEY | npx wrangler secret put GOOGLE_MAPS_API_KEY
}
if (Test-Path ".\backend\trusted_responders.json") {
    Write-Host "Uploading TRUSTED_RESPONDERS_JSON secret..." -ForegroundColor Cyan
    Get-Content ".\backend\trusted_responders.json" -Raw -Encoding UTF8 | npx wrangler secret put TRUSTED_RESPONDERS_JSON
}
if (Test-Path ".\backend\cameras.json") {
    Write-Host "Uploading CAMERAS_JSON secret..." -ForegroundColor Cyan
    Get-Content ".\backend\cameras.json" -Raw -Encoding UTF8 | npx wrangler secret put CAMERAS_JSON
}

Write-Host "Deploying GuardianMesh Worker..." -ForegroundColor Green
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { throw "wrangler deploy failed" }

if ($PublicUrl) {
    $PublicUrl = $PublicUrl.TrimEnd('/')
    Write-Host "Smoke tests against $PublicUrl" -ForegroundColor Cyan
    Invoke-RestMethod "$PublicUrl/api/status" | Format-List
    Invoke-RestMethod "$PublicUrl/api/cameras" | ConvertTo-Json -Depth 4
} else {
    Write-Host "Pass -PublicUrl (or set GUARDIANMESH_PUBLIC_URL) to run smoke tests." -ForegroundColor Yellow
}

Write-Host "DONE. Hard refresh the dashboard with Ctrl+Shift+R." -ForegroundColor Green
