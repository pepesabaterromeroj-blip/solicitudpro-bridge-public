# PREPARE → aprobación explícita en ChatGPT → APPROVE → APPLY

Primera versión acotada, 4-11-2026. Solo se ha escrito en fixtures. La primera modificación de SolicitudPro debe iniciarse posteriormente desde «Demo solicitudpro → Organizar contexto SolicitudPro».

1. ChatGPT consulta contexto/Git y llama `codex_project_change_prepare({project, instruction})` con `bridge:read`.
2. El PC activo reanuda el mismo thread de análisis. Codex propone un plan en sandbox read-only; no modifica el proyecto. Devuelve `approvalId`, digest, HEAD/fingerprint, thread/turn, archivos, checks, advertencias y caducidad.
3. ChatGPT muestra el plan y espera una respuesta explícita de Joan, como `apruebo`. Solo después llama `codex_project_change_approve({approvalId})` con `bridge:write`. APPROVE revalida proyecto/dispositivo/thread/HEAD/fingerprint y cambia únicamente el indicador de aprobación, conservando digest, TTL, instrucción, archivos y tests. El terminal no forma parte del flujo normal.
4. Solo entonces ChatGPT llama `codex_project_change_apply({approvalId})` con `bridge:write`. No admite otra instrucción, proyecto, ruta ni comando. APPLY sin APPROVE válido es rechazado.
5. El PC verifica identidad de dispositivo, proyecto, mismo thread, HEAD, rama, índice, status y hashes del contenido versionado/no ignorado. Cualquier cambio exige preparar otra vez. Un marcador exclusivo reclama el registro antes de ejecutar; no se reutiliza tras fallo o reinicio. TTL: 10 minutos.

## Ejecución y límites

Codex continúa el mismo thread **en solo lectura**, con red desactivada, apps/plugins excluidos, servidores MCP deshabilitados por overrides de esa sesión y todas las approvals denegadas. No se modifica la configuración global. Si el aislamiento no puede verificarse, la operación falla cerrada. Se solicita contenido estructurado, no comandos ni parches ejecutables.

Tras validar la respuesta y revalidar Git, el Bridge aplica exclusivamente bytes de archivos autorizados mediante `command/exec` de app-server: ejecutable Node y script constantes, contenido pasado como datos en argv, `workspaceWrite` con `writableRoots` de archivos concretos, red desactivada y sin acceso writable a temporales. No se concede workspace-write al modelo. El intento inicial con `apply_patch` no pudo escribir sin pedir una elevación adicional; esa elevación se denegó y se eligió el escritor determinista.

Máximo 5 archivos existentes, regulares, sin symlinks, limpios en Git y de hasta 6000 bytes cada uno; respuesta de contenido de hasta 8000 caracteres. Extensiones iniciales: JS, TS, CSS, HTML, Markdown y TXT. Raíces relativas desde `projects.<id>.changeRoots`, vacío por defecto en la plantilla. En clase: `js`, `tests`, `docs/proyecto`. No se autorizan archivos nuevos, renombrados, borrados, archivos ocultos, secretos, configuraciones privadas ni PLAN/LOG. Los cambios históricos dirty están protegidos. El fingerprint falla cerrado si excede 10000 archivos o 100 MB. Cada PC configura sus propias raíces y conserva sus propios registros.

Único check ejecutable inicial: ID `syntax`, resuelto internamente a `node --check` por cada JS del plan en sandbox read-only. No ejecuta el código del proyecto. Otros checks, tests que escriben artefactos y ejecución arbitraria quedan fuera de esta versión. Un resultado `CHECKS_FAILED` no representa un cambio validado.

APPLY devuelve HEAD antes/después, Git actual, archivos cambiados, stat, resumen, resultados de checks y diff saneado limitado a 1600 caracteres, con `truncated`. HEAD e índice deben permanecer iguales y todo cambio debe estar dentro del plan. No se crea commit para transmitir el resultado. Si hay interrupción o fallo, se conservan los cambios parciales para inspección mediante tools READ; no se hace rollback ni se reutiliza la aprobación. La expiración durante una operación ya iniciada no cancela retroactivamente la ejecución: se valida antes de consumirla.

## Persistencia y seguridad

Registros locales en `data/change-approvals/`, ignorados por Git; directorio restringido al usuario con ACL Windows o modo 0700. UUID aleatorio, digest del plan, TTL, aprobación humana y claim single-use. Cloudflare conserva solo contadores y correlación transitoria; no guarda registros de aprobación. La confirmación conversacional se delega explícitamente a ChatGPT: el Bridge valida identidad OAuth y estado del plan, pero no lee el chat ni puede acreditar por sí solo que una persona escribió «apruebo». Un cliente autorizado con bridge:write puede invocar APPROVE; sus instrucciones obligan a esperar el consentimiento humano.

La CLI `npm run approve-change -- <approvalId>` se conserva únicamente como fallback administrativo, no obligatorio. OAuth distingue smoke/read/write. `bridge:read` no autoriza APPLY y write no concede READ implícitamente. Añadir el scope anunciado no amplía tokens existentes: la conexión ChatGPT requiere consentimiento humano para `bridge:write`. No se exponen Git, shell, infraestructura ni escritura genérica. La URL, Worker, Durable Object y OAuth son los existentes.

Pruebas: fixture real PREPARE/APPLY con Codex, mismo thread, reinicio del servicio local, check JS PASS, diff recibido y HEAD/staged intactos. Sandbox real: archivo aprobado writable; vecino, exterior y `.git/index` protegidos; commit bloqueado al crear index.lock. Pruebas de registros: expiración, inexistente, sin confirmar, digest incorrecto, binding cambiado, restart y consumo concurrente. Gateway OAuth/relay prueba read denegado, write permitido con callback fixture, entrada adicional rechazada y regresiones de lectura/multi-device/lifecycle. Ningún PASS de escritura real sobre SolicitudPro se afirma en esta fase.
