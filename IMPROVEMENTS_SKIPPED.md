# Punti da saltare

### 1. `stopListening._pendingTime` non è per-guild
**File**: [src/database/stats.js](src/database/stats.js#L131-L136)

**Problema**: Il buffer pendente accumula tempo per `userId` senza distinguere la guild. Se un utente ascolta su 2 server, il tempo viene sommato indiscriminatamente.

**Possibile soluzione**: Usare chiavi `${guildId}_${userId}` o struttura annidata.

**Motivo skip**: Utente ha deciso di non implementare questo miglioramento.

---

### 2. Nessun dedup nella coda
**File**: [src/commands/play.js](src/commands/play.js)

**Problema**: Lo stesso video può essere aggiunto N volte alla coda senza alcun avviso.

**Possibile soluzione**: Warning (non bloccare) se URL già presente in `songs[]`.

**Motivo skip**: Utente ha deciso di non implementare questo miglioramento.

---

### 3. YouTube query senza sanitizzazione
**File**: [src/utils/youtube.js](src/utils/youtube.js#L85)

**Problema**: La `query` utente viene passata direttamente come argomento a `spawn()`. Essendo `spawn` (non `exec`), non è vulnerabile a shell injection, ma metacaratteri nel titolo possono confondere yt-dlp.

**Possibile soluzione**: Validare/escapare query utente prima di passarla a yt-dlp.

**Motivo skip**: Utente ha deciso di non implementare questo miglioramento.

---

### 4. `getVideoInfo` con `--mark-watched`
**File**: [src/utils/youtube.js](src/utils/youtube.js#L82)

**Problema**: Ogni ricerca segna il video come guardato sull'account. Se si usano cookies/auth, inquina la cronologia YouTube.

**Possibile soluzione**: Rimuovere `--mark-watched` dalle ricerche (mantenerlo solo per `play` diretto).

**Motivo skip**: Utente ha deciso di non implementare questo miglioramento.

---

### 5. Dashboard: fetch ultimo messaggio ad ogni update
**File**: [src/ui/dashboard.js](src/ui/dashboard.js#L76-L77)

**Problema**: `channel.messages.fetch({ limit: 1 })` viene chiamato ad ogni aggiornamento dashboard per verificare se è ancora l'ultimo messaggio. Spreco di API call Discord.

**Possibile soluzione**: Controllare solo quando `dashboardMessage` viene ripristinato da backup, non ad ogni update.

**Motivo skip**: Utente ha deciso di non implementare questo miglioramento.

---

### 6. Race condition in `tryPushStats()`
**File**: [index.js](index.js#L54-L192)

**Problema**: `setInterval` ogni minuto senza guardia. Se `execSync` di git impiega >60s (rete lenta), si sovrappone alla successiva esecuzione.

**Possibile soluzione**: Aggiungere un flag `isPushing` per prevenire esecuzioni concorrenti.

**Motivo skip**: Non è un vero problema perché:
- Node.js è single-threaded
- `execSync` è bloccante, quindi non può avvenire overlapping di esecuzioni
- Se git impiega >60s, il prossimo check avviene quando è già terminato

---

### 7. Player subscribe multipli
**File**: [src/audio/playback.js](src/audio/playback.js#L234)

**Problema**: `connection.subscribe(player)` viene chiamato ogni volta che il mixer riparte senza mai fare unsubscribe. Potenziali listener duplicati.

**Possibile soluzione**: Fare unsubscribe prima di re-subscribe, o verificare se già sottoscritto.

**Motivo skip**: Non è un vero problema perché:
- `discord.js` (VoiceConnection.subscribe) è idempotente
- Se già sottoscritto, riceve un warning ma non crea duplicati
- La gestione interna evita di aggiungere lo stesso player più volte

---

### 8. Lock scaduti mai puliti
**File**: [src/state/StateVersion.js](src/state/StateVersion.js#L87) — **IMPLEMENTATO**

**Problema**: I lock scaduti restano nella `this.locks` Map. Non c'è cleanup periodico — crescita lenta ma costante.

**Soluzione implementata**: Lazy cleanup dei lock durante `acquireLock()` — rimuove lock scaduti o rilasciati prima di crearne uno nuovo.

**Status**: ✅ **RISOLTO**

---

### 9. Path hardcoded per Linux
**File**: [config/paths.js](config/paths.js)

**Problema**: `YT_DLP_PATH = '/home/ubuntu/DiscordBots/...'` hardcoded per Linux production. Il fallback Windows usa `python -m yt_dlp`. Path non validati.

**Motivo skip**: L'utente ha chiarito che il bot non sarà mai avviato su Windows, quindi non è necessario mantenere compatibilità multipiattaforma. I path per Linux sono corretti e sufficienti per l'ambiente di produzione.

**Status**: ✅ **NON RICHIEDE MODIFICHE** (soluzione è già corretta per il caso d'uso reale)

---

### 10. Stats Collision su `userId` senza `guildId`
**File**: [src/database/stats.js](src/database/stats.js#L131-L136)

**Problema**: Il buffer `stopListening._pendingTime` usa solo `userId` come chiave, senza distinguere la guild. Se un utente ascolta su 2 server contemporaneamente, i tempi di ascolto si sommano indiscriminatamente.

**Possibile soluzione**: Usare chiavi `${guildId}_${userId}` e aggiornare `flushPendingAndSave` per fare il parse della chiave composta.

**Motivo skip**: Utente ha deciso di non implementare questo miglioramento.

---

### 11. YouTube query non escapata per yt-dlp
**File**: [src/utils/youtube.js](src/utils/youtube.js#L85-L92)

**Problema**: La query utente viene passata come `ytsearch1:${query}` senza sanitizzazione. Essendo `spawn` (non `exec`) non è vulnerabile a shell injection, ma metacaratteri o stringhe che iniziano con `--` potrebbero essere interpretati da yt-dlp come flag (argument injection).

**Possibile soluzione**: Sanitizzare la query rimuovendo quote, backslash, newline e stringhe tipo `--flag`.

**Motivo skip**: Utente ha deciso di non implementare questo miglioramento.

---

### 12. `VOICE_CONNECTION_TIMEOUT_MS` hardcoded
**File**: [config/constants.js](config/constants.js#L16-L20)

**Problema**: Il timeout di connessione vocale è fissato a 20 secondi. Su sistemi lenti (es. Raspberry Pi) o con I/O pesante, 20 secondi possono essere insufficienti.

**Possibile soluzione**: Rendere il valore configurabile via variabile d'ambiente (`process.env.VOICE_CONN_TIMEOUT`).

**Motivo skip**: Utente ha deciso di non implementare questo miglioramento.

---