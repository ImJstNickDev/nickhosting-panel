@php
    $italian = str_starts_with(app()->getLocale(), 'it');
@endphp
<div class="box box-primary">
    <div class="box-header with-border"><h3 class="box-title">NickHosting</h3></div>
    <div class="box-body">
        <p>{{ $italian ? 'Versione: 1.0.0.' : 'Version: 1.0.0.' }}</p>
        <p>{{ $italian
            ? 'API per account collegati, chiavi Client e notifiche dei limiti. Richiede la configurazione esplicita di NickHosting. Nessun server o account viene importato automaticamente.'
            : 'APIs for linked accounts, Client keys and resource-limit notifications. Requires explicit NickHosting configuration. No servers or accounts are imported automatically.' }}</p>
    </div>
</div>
