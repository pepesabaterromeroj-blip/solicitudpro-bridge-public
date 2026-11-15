# Operación del relay

## macOS (`home-mac`)

El relay de usuario se gestiona con un LaunchAgent y no depende de Terminal ni de los archivos de inicio del shell. La configuración, credencial, logs y estado de threads son locales e ignorados por Git.

- `npm run macos:relay -- install` instala y arranca `com.solicitudpro.bridge-relay` para la sesión del usuario.
- `npm run macos:relay -- status` comprueba el registro en `launchd` sin mostrar configuración privada.
- `npm run macos:relay -- stop` descarga el LaunchAgent y detiene el relay sin borrar el plist.
- `npm run macos:relay -- start` vuelve a cargarlo; si ya está cargado, reinicia su única instancia.
- `npm run macos:relay -- uninstall` descarga el LaunchAgent y elimina únicamente su plist generado.

El plist usa rutas absolutas, un `PATH` mínimo explícito, `RunAtLoad` y reinicio tras fallo. El relay cierra sockets obsoletos y reconecta con backoff ante caída del gateway, cambio de red o reanudación del equipo. Sus logs sanitizados rotan con el límite ya configurado.

## Windows

Tras configurar la credencial, el proyecto y Codex en cada equipo Windows, ejecutar `npm run build` y `.\relay-autostart.ps1 -Action Install` en PowerShell. La instalación verifica la configuración e inicia la tarea **SolicitudPro Bridge Relay** con la cuenta interactiva actual. La tarea arranca al iniciar sesión, tiene una única instancia y supervisa el relay. Si el proceso termina inesperadamente, vuelve a lanzarlo tras 15 segundos. Las rutas de Node y Git detectadas se guardan en la tarea local de Windows. Volver a instalar la tarea si cambian esas rutas o se mueve el checkout.

- `.\relay-autostart.ps1 -Action Status` muestra el estado en el Programador de tareas.
- `.\relay-autostart.ps1 -Action Uninstall` detiene y elimina la tarea de ese checkout.
- `npm run doctor` comprueba config, credencial presente, Git, Codex, hilo local, registro de autoarranque en Windows y salud del gateway. El recuento del gateway es global. El log local identifica la conexión de este equipo.
- `logs/relay.log` y su copia anterior registran eventos de arranque, desconexión y reintento. Cada archivo se limita a 256 KiB. Un fallo de configuración requiere corregir la causa indicada y volver a iniciar la tarea.

Cada equipo conserva su propia configuración, credencial y thread de Codex. `bridge_devices` devuelve solo los `deviceId` elegibles y su estado conectado, sin IP, hostname, rutas ni credenciales. Con un único dispositivo, las llamadas antiguas sin `deviceId` siguen seleccionándolo automáticamente. Con dos o más dispositivos, una llamada sin selector devuelve `BRIDGE_DEVICE_AMBIGUOUS`; un `deviceId` explícito selecciona exclusivamente ese relay. Un selector desconocido o desconectado devuelve `BRIDGE_DEVICE_UNAVAILABLE`, sin fallback a otro equipo.

PREPARE persiste el vínculo entre `approvalId` y `deviceId`. APPROVE y APPLY deben usar el dispositivo que creó el plan; si se desconecta, el flujo espera su reconexión mientras siga vigente y no puede saltar a otro relay. El Bridge mantiene una sola operación de modificación global a la vez.

Presupuestos antiabuso del gateway por día UTC y por dispositivo autenticado: smoke 75, lecturas 750, análisis/planes PREPARE 150 y cambios APPROVE/APPLY 150. Se cuenta cada despacho antes de enviarlo al relay; una petición rechazada por scope o dispositivo ambiguo no consume cuota. Los contadores antiguos globales no se usan. El relay local mantiene un límite adicional de 100 smoke y 1200 operaciones restantes por minuto, con recuperación automática al cambiar de ventana. Este último supera la suma de las cuotas diarias del gateway para que sus errores explícitos sean los que lleguen primero. Las respuestas de cuota usan códigos `BRIDGE_*_BUDGET_REACHED`; la ambigüedad usa `BRIDGE_DEVICE_AMBIGUOUS`. PREPARE sigue exigiendo aprobación humana explícita antes de APPROVE/APPLY.

En cada PC, `config/local.json` ignorado debe definir `contextSources` y `searchRoots` para esas lecturas; el ejemplo versionado muestra la estructura. Si una búsqueda agota el tiempo de respuesta, acotar `searchRoots` a los directorios necesarios. `changeRoots` determina los únicos archivos que podrán entrar en un plan PREPARE y requiere una elección local explícita; habilitarlo no omite OAuth write ni la aprobación humana posterior.

OAuth renueva automáticamente el access token de 10 minutos mientras el grant siga vigente. Los nuevos grants duran inicialmente 30 días. Cada refresh correcto rota el token y vuelve a fijar el vencimiento a 30 días desde ese momento, también para los grants anteriores todavía vigentes. Si el refresh devuelve `OAUTH_REAUTH_REQUIRED`, reconectar el MCP existente. La duración del grant es independiente de los 10 minutos del ID de aprobación.
