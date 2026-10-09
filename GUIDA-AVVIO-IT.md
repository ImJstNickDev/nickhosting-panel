# Come iniziare con Codex

M0 è stato approvato e unito con un'autorizzazione esplicita valida soltanto per la PR #1. M1 introduce il backend, la configurazione e l'identità su un ramo dedicato; la relativa PR rimane aperta per la review. Consultare [sviluppo e test](docs/DEVELOPMENT.md) e [contratti API](docs/M1-API.md). Nessuna infrastruttura di produzione è stata modificata; PostgreSQL/Redis di test sono risorse isolate autorizzate separatamente. Il frontend completo resta in M6.

## Sequenza operativa

1. Scegli la cartella locale destinata alla **nuova** repository `nickhosting-panel`. Non usare la repository del sito `nickhost.ing`.
2. Copia qui l'intero contenuto del pacchetto (anche le cartelle nascoste `.codex` e `.github`). Se `.codex` esiste già, fallo **integrare**, senza sovrascrivere configurazioni non collegate al progetto.
3. Avvia Codex e usa il prompt **Prepping** da `docs/CODEX-PROMPTS.md` (o `PREPPING.md`). Controlla che le verifiche siano passate.
4. Il bootstrap M0 è già completato; non reinizializzare Git o ricreare la repository. Usare il prompt del solo milestone autorizzato.
5. Condividi il link della PR del milestone per la review. Codex non può unire M1 né iniziare M2 senza una nuova autorizzazione.

## Regola sui server di test

Codex può anche distruggere/cancellare server e dati **soltanto se è dimostrabile che quel server è stato creato da Codex durante i test**. Se c'è il minimo dubbio sulla proprietà, si ferma e chiede. Modifiche a Wings, Pterodactyl, networking Docker, DNS reali e altre configurazioni di produzione restano soggette a consenso specifico.

## Hostname e deployment

NickHosting WebPanel e il pannello Pterodactyl esistente utilizzeranno hostname distinti e configurabili. Il WebPanel usa `NH_PUBLIC_URL` in `.env` (e le impostazioni Owner dove previsto). Gli indirizzi effettivi e le note della macchina restano in `.codex/local/INFRASTRUCTURE.md`, ignorato da Git ma disponibile a Codex prima delle attività infrastrutturali autorizzate. Qualsiasi modifica effettiva a DNS, reverse proxy o infrastruttura richiede comunque la tua approvazione esplicita.

## Panoramica dei documenti

- `AGENTS.md`: vincoli obbligatori per tutti gli agenti.
- `.codex/`: impostazioni subagent e profili di ricerca/implementazione/review.
- `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`: prodotto e componenti.
- `docs/MILESTONES.md`: Prepping + M0–M6 e criteri di accettazione.
- `docs/GITHUB-WORKFLOW.md`: Issue, PR, review, niente Actions.
- `docs/decisions/`: decisioni architetturali (ADR) versionate.

La documentazione tecnica è volutamente in inglese, così Codex potrà usarla direttamente. L'applicazione avrà inglese e italiano, con i18n completa.
