# Push VPN Portal to GitHub
# Run in PowerShell from this folder

$gh = "C:\Program Files\GitHub CLI\gh.exe"
if (-not (Test-Path $gh)) {
    Write-Host "GitHub CLI not found. Install: winget install GitHub.cli" -ForegroundColor Red
    exit 1
}

# Refresh PATH for this session
$env:Path = "C:\Program Files\GitHub CLI;" + $env:Path

Set-Location $PSScriptRoot

Write-Host "Checking GitHub login..."
& $gh auth status 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Login required. Browser will open." -ForegroundColor Yellow
    & $gh auth login -h github.com -p https -w
}

$repoName = "vpn-portal"
$user = (& $gh api user -q .login 2>$null)
if (-not $user) {
    Write-Host "Could not get GitHub username" -ForegroundColor Red
    exit 1
}

Write-Host "GitHub user: $user"

$remotes = git remote 2>$null
if ($remotes -notcontains "origin") {
    Write-Host "Creating repo $user/$repoName and pushing..."
    & $gh repo create $repoName --public --source=. --remote=origin --push
} else {
    Write-Host "Pushing to origin..."
    git push -u origin main
}

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Done! Site URL:" -ForegroundColor Green
    Write-Host "  https://$user.github.io/$repoName/" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Next: GitHub -> Settings -> Pages -> Source: GitHub Actions"
    Write-Host "Secrets: SSH_PASS_SHM, SSH_PASS_EVKA"
}
