@php
    $italian = str_starts_with(app()->getLocale(), 'it');
@endphp
<div class="box box-primary">
    <div class="box-header with-border"><h3 class="box-title">NickHosting <small>1.0.1</small></h3></div>
    <div class="box-body">
        @if (session('nickhosting_saved'))
            <div class="alert alert-success" role="status">{{ $italian ? 'Impostazione salvata.' : 'Setting saved.' }}</div>
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
