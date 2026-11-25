# Codex Pocket continuation — latest user authorized scheduled autonomous work

User on 2026-11-18 Asia/Shanghai: “你就一直挂着跑吧，定个定时任务，跑完再说”. Keep working autonomously, no routine progress chatter; report when done or a concrete user-only account/device choice is needed.

Schedule: schedule-6fa049fc-1263-4c47-b58c-04fa5d625655, every 15 minutes starting 2026-11-19 00:08:18 Asia/Shanghai, this session. Pause schedule after completion. Goal goal-4f1fc873-20c7-46d0-9aea-b06a3a944dd1 revision2 active. Current permissions danger-full-access, no approval prompts; never set sandbox_permissions.

## Critical requirement

User explicitly rejected DSH engine + Codex model branding. Must run official codex app-server. DSH Go is only reusable wheels (Flutter components/Android PRoot tar installer/process ownership/foreground keepalive). UI is cream neutral like user-provided Codex POCKET screenshot. Do not use old DSH headless/purge/provider tests as evidence for new engine.

## Workspace and source

Workspace C:/Users/13721/Documents/deepseek-harness/default-workspace.
Source used: codex-go/dshgo-fork/dsh-Go-main (ZIP, no .git). codex-go-app is another concurrent project: DO NOT MODIFY or kill its builds.
App id io.github.codexgo.app, Kotlin namespace io.github.ccch1mneyyy.dsh_app.
Bundled node: C:/Users/13721/DSH-Instances/Pure/home/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe
Bundled python similarly dependencies/python/python.exe.
PowerShell: Set-ExecutionPolicy -Scope Process Bypass -Force; . codex-go/tooling/env.ps1; supplies local Flutter3.47.7/Dart3.13.5/JDK17/SDK36/NDK28.2 and local TEMP/PUB/Gradle caches.

## Current actual code

- bridge/server.mjs was finally rewritten by lead: ONLY real app-server default, no fake or DSH normal path; Node HTTP/SSE, strict app-server RPC, config native batchWrite + local secret env file, auth, model/account, thread create/list/resume, turn send/interrupt, approvals. --codex executable and repeat --codex-arg supports protocol fixtures. /healthz {ok,engine:'codex',mode:'app-server'}; launch line `codex-go: http://127.0.0.1:PORT/?token=...`. adapter.mjs official0.170 events/thread+turn binding; tool aggregatedOutput replace:true. Need REAL CLI integration still, schema differences may remain.
- test/bridge-contract.test.mjs + protocol-fixture.mjs: 8 test count passed by lead, explicit synthetic JSON-RPC executable, actual HTTP/SSE; auth/origin/body/configsecret/restartseq/threads/busy/approval/end/fail recovery. This is not real Codex proof. Fixed retired child exit rejecting replacement process requests.
- Official Codex0.170.0 Win binary downloaded+SRI: tooling/sdk/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe (385MB); --version verified codex-cli0.170.0. ARM official platform tgz cache 173169777 bytes SRI mJLm... verified by agent; actual ELF AArch64 static musl/no interpreter.
- Official schema in tooling/sdk/codex/schema/{codex_app_server_protocol.schemas.json,codex_app_server_protocol.v2.schemas.json}; generated source tag rust-v0.170.0.
- app/lib/main.dart now starts CodexPocketApp directly, no DshApp/RootGate/Riverpod. lib/codex/{app,state,ui}.dart independent light UI. Agent codex-mobile-ui still improving behavioral bugs and screenshot QA; do not clobber its writes.
- native main Kotlin MainActivity now minimal Flutter engine registering only CodexRuntimePlugin. Manifest now minimal MainActivity + CodexRuntimeService permissions INTERNET/FGS/WAKELOCK. Native six-file allowlist in app/android/app/build.gradle.kts includes MainActivity,codex/**,runtime/TarExtractor.kt,RuntimeProcessOwnership.kt. Old Kotlin/source retained but not compiled. dependencies XZ+JUnit+JSON only. resValues=true needed AGP9.
- lead wrote codex/CodexRuntime.kt, CodexRuntimePlugin.kt, CodexRuntimeService.kt: own filesDir/codex-runtime; manifest requires codexGo.engine codex-app-server; SHA256 tar streaming installer; proot launch.argv + guestEnv/env; token parse plus real /healthz ok enginecodex required; status/events/install/start/stop/logs channels codex/runtime. Foreground/wakelock; stop reuses /proc RuntimeProcessOwnership with UID+starttime checks rather than PID reflection. Still must compile+test, lifecycle concerns startup watchdog/install races can be reviewed.
- pubspec drastically minimized 2026-11-18 23:45: Flutter/localizations/http/gpt_markdown/url_launcher/secure_storage/shared_preferences/path_provider/webview_flutter/xterm/yaml. No DSH/Riverpod/sherpa/webrtc/mobile_scanner/filepicker dependency. Old source remains archival, target-only analyze new root; old tests won't build. test/flutter_test_config.dart simplified real font loader only. pub get succeeded; targeted dart analyze lib/main.dart lib/codex test/codex_pocket NO issues.
- web/index.html,pocket.css,pocket.js by codex-web-ui light exact-ish Demo; browser fixture/CDP tests pass including tasks/history/stream/settings/approval/CORS failure. Await final screenshots copied into codex-go/shots and freeze notice.
- runtime true Codex builder tooling/build-codex-runtime.py by codex-arm-runtime strips opt/dsh,opt/dsh-go,etc oldshims/home, preserves Ubuntu/Node/Python/git/proot, adds ARM Codex+bridge+web. Stage under runtime/stage/codex-app-server/arm64-v8a verified; agent working final runtime/out/arm64-v8a. Must compare final archive source hashes to latest bridge/web (they changed after initial stage). Manifest codexGo.engine codex-app-server, final true only when frozen. Old DSH runtime/out must not be accepted. Real ARM/Termux execution untested.

## Agents and outstanding scope

- codex-engine: official Win install done, test/codex-real-smoke.mjs authored. Lead took over server+adapter and real test now; tell agent ONLY read official schema for incompatibility, no overwrite server/test.
- codex-mobile-ui: owns lib/codex and test/codex_pocket. Reported8 tests, but latest golden had red Unexpected engine codex-app-server because mock wrong and code/approval text boxes. Lead told fix fixture enginecodex + load fonts/JetBrainsMono and neutral code background. Also told state bugs to fix: process all-thread busy map before active-thread filter; don't clear others on create; connect seq reset only on host/token change; approval.resolved removes card; text/reasoning combine by same item/type; health must actualenginecodex; native repeatedlogrunning should not reconnect.
- codex-web-ui: owns web/** and test/web-*; declared browser/CDP fixture PASS, screenshotpaths initially temp; lead told copy into codex-go/shots, freeze and notify ARM. No persistent bridge currently. Same-origin Web policy intentional.
- codex-arm-runtime: owns true builder + runtime/codex-go new verify/Termux; stage validated 14026entries,300MBcompressed1.14GBtar, noDSH; final repack in progress. Need collect its job and hash/source snapshot.
- gradle-network: owns build/network/cache/proxy; many Maven official hash validated jars cached. Current source trimmed, last message about retained shared_preferences_android needing KGP2.3 and proxy crashed. Should fix proxy (loopback18766) autonomously. Waiting retry after latest pubget succeeded; message it. Owns build exclusively; don't launch duplicate. Need get actual task error/compilesuccess. Goal final APK assemble after sources/runtime frozen.
- mobile-audit: completed read-only assessment, no writes now.
- codex-provider: contractfixtures done, no writes now.
- backend-audit: oldDSHsmoke done, no relevance.

## Last real CLI smoke and next immediate fix

Lead ran actual Win Codex with LOCALAPPDATA and TEMP pointed to workspace SDK user-state; it initialized successfully, so agent's old SQLite failures were its sandbox/temp env, NOT product-proof. test/codex-real-smoke.mjs initially failed `thread/resume` on a fresh empty thread: no rollout exists until a turn. Lead already changed noAuthSmoke's thread/resume/read to optional negatives `thread/resume-empty`, `thread/read-empty` (don't require success). Need rerun real smoke --fixture.

Command from workspace:
$env:LOCALAPPDATA="$pwd/codex-go/tooling/sdk/user-state/local"; $env:TEMP="$pwd/codex-go/tooling/sdk/user-state/temp"; $env:TMP=$env:TEMP; & <bundled node> codex-go/test/codex-real-smoke.mjs "$pwd/codex-go/tooling/sdk/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe" --fixture

Known likely test bug still unpatched: fixtureSmoke(home,fixture) writes home/config.toml before mkdir(home,{recursive:true}); add mkdir or get ENOENT. Test must actual Codex Responses fixture text stream + auth, not treat CLI initialize as full passed. After that add real bridge HTTP end-to-end using official binary to validate config/read/batchWrite provider semantics. Official0.170 AskForApproval string enums ONLY untrusted,on-request,never; lead removed on-failure. thread list sort updated_at accepted. Need UserInput text field possible text_elements schema but real checks decide.

## Workflow

No USB install has occurred; early ADB only queried device (Android16 ARM64 connected) before user corrected order. Do not touch phone until computer new trueCodex tests+APK build and artifact checks complete, then install new package only (no uninstall/overwrite old).
Stop any owned test process in finally. Do not touch unrelated codex-go-app/DSH GUI servers/user credentials. Use actual local API key fixture only; no user account needed until actual login on new app.
When reporting final, separate real CLI vs explicit fixture vs actual Android/Termux tests; do not call full desktop parity achieved without evidence. User requested scheduled completion report only, minimize commentary.
