# Git Setup Instructions

## Step 1: Inizializza Git (una sola volta)

Apri PowerShell e naviga nella cartella del progetto:

```powershell
cd f:\Programmi\Bots\DiscordMusicBot
```

Poi esegui questi comandi UNO ALLA VOLTA:

```powershell
git init
```

```powershell
git add .
```

```powershell
git commit -m "Initial commit: music bot with statistics system"
```

---

## Step 2: Crea un repo su GitHub

1. Vai su https://github.com/new
2. Crea un repo vuoto con il nome `DiscordMusicBot`
3. **NON** spuntare "Add a README file" o ".gitignore" (li hai già)
4. Clicca "Create repository"
5. Copia l'URL del repo (tipo: `https://github.com/tuousername/DiscordMusicBot.git`)

---

## Step 3: Collega il repo locale a GitHub

Nel PowerShell, esegui:

```powershell
git remote add origin https://github.com/tuousername/DiscordMusicBot.git
```

(Cambia `tuousername` con il tuo username GitHub)

---

## Step 4: Pusha la versione iniziale

```powershell
git branch -M main
```

```powershell
git push -u origin main
```

Se ti chiede username/password:
- Username: il tuo GitHub username
- Password: un **Personal Access Token** (non la password di GitHub!)

### Come creare un Personal Access Token:
1. Vai a https://github.com/settings/tokens
2. Clicca "Generate new token (classic)"
3. Spunta: `repo`, `workflow`, `write:packages`
4. Copia il token e usalo come password

---

## Step 5: Crea il branch per i wrap

```powershell
git checkout -b wrap-data
```

```powershell
git push -u origin wrap-data
```

Poi torna a main:

```powershell
git checkout main
```

---

## Step 6: Verifica su GitHub

Vai su https://github.com/tuousername/DiscordMusicBot

Dovresti vedere:
- Branch `main` con il codice
- Branch `wrap-data` vuoto (per ora)
- File `.github/workflows/monthly-wrap.yml`
- File `scripts/generate-wrap.js`

---

## Da oggi in poi

Ogni volta che modifichi il codice:

```powershell
git add .
git commit -m "Il tuo messaggio qui"
git push origin main
```

---

## Workflow automatico

Ogni **1° del mese alle 10:00 UTC** GitHub Actions farà automaticamente:
1. Leggerà `data/stats.json`
2. Genererà il wrap HTML
3. Farà il push sul branch `wrap-data`

Se vuoi testarlo manualmente:
1. Vai su https://github.com/tuousername/DiscordMusicBot/actions
2. Seleziona "Monthly Wrap Generation"
3. Clicca "Run workflow" → "Run workflow"
4. Attendi qualche minuto

---

## Troubleshooting

### "fatal: not a git repository"
Assicurati di essere nella cartella giusta:
```powershell
cd f:\Programmi\Bots\DiscordMusicBot
git status  # Deve mostrare il branch, non errori
```

### "fatal: refusing to merge unrelated histories"
Se il merge fallisce, usa:
```powershell
git checkout wrap-data
git merge main --allow-unrelated-histories
git push origin wrap-data
```

### "Unauthorized" o errore di autenticazione
Usa il Personal Access Token (vedi Step 4), non la password di GitHub.
