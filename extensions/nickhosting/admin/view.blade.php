@php
    $operationalLabels = [
        'downloadBatchLimit' => ['Download URLs per request', 'URL download per richiesta'],
        'uploadBatchLimit' => ['Upload URLs per request', 'URL upload per richiesta'],
        'signedUrlTtlSeconds' => ['Signed URL lifetime (seconds)', 'Durata URL firmati (secondi)'],
        'webhookBatchLimit' => ['Notifications per delivery job', 'Notifiche per job di consegna'],
        'webhookConnectTimeoutSeconds' => ['Webhook connection timeout (seconds)', 'Timeout connessione webhook (secondi)'],
        'webhookTimeoutSeconds' => ['Webhook response timeout (seconds)', 'Timeout risposta webhook (secondi)'],
    ];
    $italian = str_starts_with(app()->getLocale(), 'it');
@endphp
<div class="box box-primary">
    <div class="box-header with-border"><h3 class="box-title">NickHosting <small>1.3.0</small></h3></div>
    <div class="box-body">
        <ul>
            <li>{{ $italian ? 'Crea account tecnici Pterodactyl separati per gli utenti NickHosting.' : 'Creates separate Pterodactyl technical accounts for NickHosting users.' }}</li>
            <li>{{ $italian ? 'Genera, ruota e revoca le Client API key dei soli account collegati.' : 'Issues, rotates and revokes Client API keys for linked accounts only.' }}</li>
            <li>{{ $italian ? 'Blocca accesso web e mail degli account tecnici.' : 'Blocks browser access and mail for technical accounts.' }}</li>
            <li>{{ $italian ? 'Notifica le modifiche ai limiti e all’identità dei server collegati tramite webhook firmati.' : 'Reports linked-server limit and identity changes through signed webhooks.' }}</li>
            <li>{{ $italian ? 'Fornisce snapshot dei limiti e stato delle notifiche per il recupero.' : 'Provides limit snapshots and notification status for recovery.' }}</li>
            <li>{{ $italian ? 'Genera URL Wings firmati per più upload con una sola richiesta Client API.' : 'Generates signed Wings URLs for multiple uploads in one Client API request.' }}</li>
            <li>{{ $italian ? 'Prepara URL Wings monouso per più file da scaricare, senza leggerne il contenuto.' : 'Prepares one-use Wings download URLs for multiple files without reading their contents.' }}</li>
        </ul>
        @if (session('nickhosting_saved'))
            <div class="alert alert-success" role="status">{{ $italian ? 'Impostazioni salvate.' : 'Settings saved.' }}</div>
        @endif
        <form method="post" action="{{ $root }}">
            @csrf
            @method('PATCH')
            <div class="form-group {{ $errors->has('origin') ? 'has-error' : '' }}">
                <label for="nickhosting-origin">{{ $italian ? 'URL NickHosting' : 'NickHosting URL' }}</label>
                <input class="form-control" id="nickhosting-origin" name="origin" type="url" maxlength="2048"
                    value="{{ old('origin', $origin) }}" autocomplete="off" spellcheck="false"
                    aria-describedby="nickhosting-origin-help{{ $errors->has('origin') ? ' nickhosting-origin-error' : '' }}"
                    @if ($errors->has('origin')) aria-invalid="true" @endif>
                <p id="nickhosting-origin-help" class="help-block">{{ $italian
                    ? 'Usa solo l’origine HTTPS. Lascia vuoto per disabilitare le notifiche.'
                    : 'Use the HTTPS origin only. Leave blank to disable notifications.' }}</p>
                @if ($errors->has('origin'))
                    <p id="nickhosting-origin-error" class="help-block" role="alert">{{ $errors->first('origin') }}</p>
                @endif
            </div>
            <h4>{{ $italian ? 'Trasferimenti e notifiche' : 'Transfers and notifications' }}</h4>
            @foreach ($operationalDefinitions as $name => $definition)
                <div class="form-group {{ $errors->has($name) ? 'has-error' : '' }}">
                    <label for="nickhosting-{{ $name }}">{{ $operationalLabels[$name][$italian ? 1 : 0] }}</label>
                    <input class="form-control" id="nickhosting-{{ $name }}" name="{{ $name }}" type="number"
                        min="{{ $definition['min'] }}" max="{{ $definition['max'] }}" step="1" required
                        value="{{ old($name, $operational[$name]) }}"
                        aria-describedby="nickhosting-{{ $name }}-help{{ $errors->has($name) ? ' nickhosting-'.$name.'-error' : '' }}"
                        @if ($errors->has($name)) aria-invalid="true" @endif>
                    <p id="nickhosting-{{ $name }}-help" class="help-block">{{ $italian ? 'Intervallo' : 'Range' }}:
                        {{ $definition['min'] }}–{{ $definition['max'] }}. {{ $italian ? 'Predefinito' : 'Default' }}: {{ $definition['default'] }}.</p>
                    @if ($errors->has($name))
                        <p id="nickhosting-{{ $name }}-error" class="help-block" role="alert">{{ $errors->first($name) }}</p>
                    @endif
                </div>
            @endforeach
            <p class="help-block">{{ $italian
                ? 'I nuovi limiti valgono dalle richieste successive. Gli URL già emessi conservano la scadenza originale. Il timeout di connessione non supera quello di risposta.'
                : 'New limits apply to subsequent requests. Already-issued URLs keep their original expiry. The connection timeout cannot exceed the response timeout.' }}</p>
            <button type="submit" class="btn btn-primary">{{ $italian ? 'Salva' : 'Save' }}</button>
        </form>
        <p style="margin-top: 16px">{{ $italian
            ? 'Questo indirizzo autorizza la destinazione delle notifiche. I collegamenti esistenti non vengono spostati automaticamente; quelli verso un indirizzo diverso restano sospesi.'
            : 'This address permits notification delivery. Existing connections are not moved automatically; connections to a different address remain paused.' }}</p>
        <h4>{{ $italian ? 'Collegamenti registrati' : 'Registered connections' }}</h4>
        @forelse ($instances as $instance)
            <dl>
                <dt>{{ $italian ? 'Destinazione' : 'Destination' }}</dt><dd>{{ $instance['callback'] }}</dd>
                <dt>{{ $italian ? 'Notifiche' : 'Notifications' }}</dt><dd>{{ $instance['allowed']
                    ? ($italian ? 'Destinazione consentita' : 'Destination allowed')
                    : ($italian ? 'Sospese: destinazione non consentita' : 'Paused: destination not allowed') }}</dd>
                <dt>{{ $italian ? 'In attesa' : 'Pending' }}</dt><dd>{{ $instance['pending'] }}</dd>
                <dt>{{ $italian ? 'Ultima consegna confermata (UTC)' : 'Last acknowledged delivery (UTC)' }}</dt>
                <dd>{{ $instance['lastDelivered'] ?? ($italian ? 'Nessuna' : 'None') }}</dd>
            </dl>
        @empty
            <p>{{ $italian ? 'Nessuna istanza collegata. Completa la connessione da NickHosting.' : 'No instance connected. Complete the connection from NickHosting.' }}</p>
        @endforelse
    </div>
</div>
