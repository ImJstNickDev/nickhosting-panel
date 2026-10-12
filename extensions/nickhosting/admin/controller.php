<?php
namespace Pterodactyl\Http\Controllers\Admin\Extensions\{identifier};

use Illuminate\Http\Request;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\View\View;
use Illuminate\View\Factory as ViewFactory;
use Pterodactyl\Http\Controllers\Controller;
use Pterodactyl\Services\Helpers\SoftwareVersionService;
use Pterodactyl\BlueprintFramework\Libraries\ExtensionLibrary\Admin\BlueprintAdminLibrary;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\Settings;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\Protocol;

class {identifier}ExtensionController extends Controller
{
    public function __construct(private BlueprintAdminLibrary $blueprint, private SoftwareVersionService $version,
        private ViewFactory $view, private Settings $settings) {}

    private function authorizeAdmin(Request $request): void
    {
        abort_unless($request->user()?->root_admin, 403);
    }

    public function index(Request $request): View
    {
        $this->authorizeAdmin($request);
        $origin = $this->settings->origin();
        $instances = DB::table('nickhosting_instances')->select('id', 'callback_url')->get()->map(function ($instance) use ($origin) {
            return ['callback' => $instance->callback_url,
                'allowed' => Protocol::callbackAllowed($instance->callback_url, $origin === '' ? [] : [$origin]),
                'pending' => DB::table('nickhosting_outbox')->where('instance_id', $instance->id)->whereNull('delivered_at')->count(),
                'lastDelivered' => ($date = DB::table('nickhosting_outbox')->where('instance_id', $instance->id)->max('delivered_at'))
                    ? \Illuminate\Support\Carbon::parse($date)->utc()->toIso8601String() : null];
        });
        return $this->view->make('admin.extensions.{identifier}.index', [
            'blueprint' => $this->blueprint, 'version' => $this->version,
            'root' => '/admin/extensions/{identifier}', 'origin' => $origin, 'instances' => $instances,
            'operational' => $this->settings->operational(), 'operationalDefinitions' => Settings::OPERATIONAL]);
    }

    public function update(Request $request): RedirectResponse
    {
        $this->authorizeAdmin($request);
        $italian = str_starts_with(app()->getLocale(), 'it');
        $message = $italian ? 'Inserisci un URL HTTPS senza percorso, credenziali o parametri.' : 'Enter an HTTPS URL without a path, credentials or parameters.';
        $rules = ['origin' => ['sometimes', 'nullable', 'string', 'max:2048', function ($attribute, $value, $fail) use ($message) {
            if (Settings::normalizeOrigin($value) === null) { $fail($message); }
        }]];
        foreach (Settings::OPERATIONAL as $name => $definition) {
            $rules[$name] = ['sometimes', 'required', 'integer', 'min:' . $definition['min'], 'max:' . $definition['max']];
        }
        $input = $request->validate($rules);
        $values = [];
        foreach (Settings::OPERATIONAL as $name => $definition) {
            if (array_key_exists($name, $input)) { $values[$name] = (int) $input[$name]; }
        }
        DB::transaction(function () use ($input, $values) {
            if (array_key_exists('origin', $input)) { $this->settings->save($input['origin'] ?? ''); }
            $this->settings->saveOperational($values);
        });
        return redirect('/admin/extensions/{identifier}')->with('nickhosting_saved', true);
    }
}
