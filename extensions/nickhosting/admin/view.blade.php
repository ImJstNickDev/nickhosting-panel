@php
    $italian = str_starts_with(app()->getLocale(), 'it');
@endphp
<div class="box box-primary">
    <div class="box-header with-border"><h3 class="box-title">NickHosting</h3></div>
    <div class="box-body">
        <p>{{ $italian ? 'Versione di sviluppo: 0.1.0-dev.' : 'Development version: 0.1.0-dev.' }}</p>
        <p>{{ $italian
            ? 'Disponibile solo il riconoscimento dell’estensione tramite API. Gestione delle chiavi e notifiche delle modifiche non ancora disponibili.'
            : 'Only API capability discovery is available. Key management and change notifications are not available yet.' }}</p>
    </div>
</div>
