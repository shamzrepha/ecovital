# EcoVital 1-Click Build, Git Push & Vercel / Firebase Deploy Script
# Usage: .\deploy.ps1 [optional-git-remote-url]

param(
  [string]$GitRemote = ""
)

$ErrorActionPreference = "Stop"

Write-Host ">> 1. Running automated test suite (17 tests)..." -ForegroundColor Cyan
npm test

Write-Host ">> 2. Building production Next.js web app & companion app..." -ForegroundColor Cyan
npm run build

if ($GitRemote -ne "") {
  Write-Host ">> 3. Linking Git remote $GitRemote and pushing..." -ForegroundColor Cyan
  git remote remove origin 2>$null
  git remote add origin $GitRemote
  git branch -M main
  git push -u origin main --force
} elseif ((git remote) -contains "origin") {
  Write-Host ">> 3. Pushing to origin..." -ForegroundColor Cyan
  git push origin HEAD
} else {
  Write-Host ">> Tip: To push to GitHub, run: .\deploy.ps1 https://github.com/shamzrepha/ecovital.git" -ForegroundColor Yellow
}

Write-Host ">> 4. Deploying to Vercel (Production)..." -ForegroundColor Cyan
vercel --prod
