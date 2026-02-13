#!/usr/bin/env pwsh
<#
.DESCRIPTION
Script che pushes stats.json e trigga il workflow GitHub
Uso: .\scripts\update-stats.ps1
#>

param(
    [switch]$SkipPush  # Se set, salta il push locale e va diretto al workflow
)

Write-Host "📊 MusicBot Stats Update Pipeline" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan

# Step 1: Push dei dati locali
if (-not $SkipPush) {
    Write-Host "`n1️⃣ Pushing stats.json to GitHub..." -ForegroundColor Yellow
    try {
        node scripts/push-stats.js
        Write-Host "✅ Push completato!" -ForegroundColor Green
        Write-Host "⏳ Aspetto 5 secondi per sincronizzare..." -ForegroundColor Gray
        Start-Sleep -Seconds 5
    }
    catch {
        Write-Host "❌ Errore durante push: $_" -ForegroundColor Red
        exit 1
    }
}

# Step 2: Trigger workflow via GitHub CLI
Write-Host "`n2️⃣ Triggering Monthly Wrap workflow..." -ForegroundColor Yellow

# Controlla se gh CLI è installato
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host "⚠️ GitHub CLI non trovato. Installa da: https://cli.github.com" -ForegroundColor Yellow
    Write-Host "📝 Oppure vai manualmente a:" -ForegroundColor Yellow
    Write-Host "   https://github.com/caccaboss89-glitch/MusicBot/actions/workflows/monthly-wrap.yml" -ForegroundColor Cyan
    exit 1
}

try {
    gh workflow run monthly-wrap.yml --repo caccaboss89-glitch/MusicBot
    Write-Host "✅ Workflow triggered!" -ForegroundColor Green
    Write-Host "`n🎯 Status: guarda su https://github.com/caccaboss89-glitch/MusicBot/actions" -ForegroundColor Cyan
}
catch {
    Write-Host "❌ Errore triggering workflow: $_" -ForegroundColor Red
    exit 1
}

Write-Host "`n✨ Done! Stats saranno aggiornati tra poco." -ForegroundColor Green
