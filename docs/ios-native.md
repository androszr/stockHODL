# Plan: StockHODL natywnie na iOS (SwiftUI) + dystrybucja deweloperska na iPhone

**Data:** 2026-08-17 (rewizja: decyzja użytkownika — SwiftUI zamiast Expo)
**Status:** draft do przeglądu
**Zakres:** CZĘŚĆ A — natywny klient SwiftUI w tym samym repo, Next.js zostaje
backendem; CZĘŚĆ B — wgranie wersji deweloperskiej na jeden iPhone, bez App
Store, z instalacją „po linku".

Punkt odniesienia — co jest w repo (stan na dziś):

| Co | Ile / gdzie |
|---|---|
| Strony App Routera | 19 pod `src/app/` |
| Server Actions | 6 modułów (`holdings`, `transactions`, `portfolios`, `watchlist`, `options`, `dividends`) — mutacje i część odczytów (serie wykresów, FX) idą przez akcje, nie przez REST |
| Endpointy JSON | `/api/auth/*`, `/api/quotes` (+`/stream` SSE), `/api/quotes/watchlist` (+`/stream`), `/api/quotes/options`, `/api/symbols/search`, `/api/logo/[symbol]`, `/api/news/*`, `/api/cron/*` |
| Auth | Better Auth **passkey-only** (`src/lib/auth.ts`), cookie `__Host-`, sliding 7 dni, dwie bramki allowlisty, `rpID = sawa-finance.vercel.app` |
| Pieniądze | Postgres `numeric` → string → `decimal.js` (`src/lib/money.ts`); cały kontrakt `Quote`/`Candle`/`LivePayload` przenosi kwoty jako **decimal-stringi** — API-ready |
| Live | REST baseline + SSE (`stream-response.ts`), polling fallback sterowany `src/lib/holdings/poll-policy.ts` |
| Deploy | push do `main` = deploy (GitHub Actions → Vercel), prod `https://sawa-finance.vercel.app` |

---

# CZĘŚĆ A — natywny klient SwiftUI

## A.1 Decyzja (rozstrzygnięta — zapis, nie dyskusja)

- **Capacitor: odrzucony.** Aplikacji nie da się wyeksportować statycznie
  (RSC + Server Actions), a w trybie remote-URL WKWebView nie ma WebAuthn —
  passkey-only logowanie nie działa; wydajnościowo to ta sama PWA co dziś.
- **Expo/React Native: rozważony i odrzucony.** Argumenty decyzji:
  (1) passkeys przez `AuthenticationServices` znoszą największe ryzyko planu
  (w Expo była to najsłabsza zależność — młode biblioteki mostkujące);
  (2) UI i tak jest przepisywany w 100% w obu wariantach — reużycie logiki
  w Expo to kilkaset linii izomorficznego TS, nie kamień milowy;
  (3) cała dotychczasowa walka z jankiem Reacta (`ticker-tile-equal.ts`,
  `holding-card-equal.ts`, ręczne memo comparators) znika przy `@Observable`
  i drobnoziarnistej inwalidacji SwiftUI;
  (4) widgety i Live Activities są realnym celem — natywnie osiągalne wprost;
  (5) Swift Charts w SDK zamiast victory-native/Skia.
- **Wybrane: SwiftUI + Next.js jako API.** Koszt, który zostaje z każdego
  wariantu i jest od klienta niezależny: brakująca warstwa API (A.5) i zmiany
  auth po stronie serwera (A.6).

## A.2 Struktura repo — projekt Xcode obok Next.js

Wymaganie: jedno repo, projekt naturalnie ewoluuje w stronę SwiftUI.

- **Katalog `ios/`** w rootcie; w nim `ios/StockHODL.xcodeproj` i źródła
  `ios/StockHODL/` (+ `ios/StockHODLTests/`, później `ios/StockHODLWidgets/`).
  Root repo nie dostaje ani jednego nowego pliku poza `ios/` i wpisami niżej —
  żadnych `*.xcodeproj`, `Package.swift` ani skryptów Xcode luzem w rootcie.
- **Zależności: SPM, bez CocoaPods.** Żadnego `Podfile`, `Pods/` ani
  `.xcworkspace` generowanego przez pody. v1 celuje w zero zależności
  zewnętrznych (Keychain, SSE po `URLSession.bytes`, Charts — wszystko w SDK);
  jeśli coś dojdzie, to przez SPM zapisany w pbxproj.
- **`project.pbxproj` commitowany wprost, bez XcodeGen/Tuist.** Rozstrzygnięcie
  wprost: generatory projektów istnieją po to, żeby zespół nie merge'ował
  pbxproj; przy jednej osobie konflikty nie występują, a generator to
  dodatkowe narzędzie do utrzymania i kolejny krok builda. Mitygacja churnu:
  źródła jako **synchronized folder references** (Xcode 16+, „buildable
  folders") — dodanie pliku nie modyfikuje pbxproj. Jeżeli kiedyś pojawi się
  drugi komputer/osoba i pbxproj zacznie boleć, migracja do XcodeGen jest
  odwracalna — nie decyzja na dziś.
- **`.gitignore`** (sekcja iOS, dopisywana do istniejącego):
  `ios/DerivedData/`, `**/xcuserdata/`, `*.xcuserstate`,
  `ios/**/*.xcworkspace/xcuserdata/`, `ios/build/`,
  `ios/StockHODL/Generated/*.tmp` (artefakty pośrednie codegenu; sam
  wygenerowany Swift JEST commitowany — patrz A.3).
- **CI web nie może zacząć mielić Swifta:**
  - `ci.yml` i `deploy.yml`: `paths-ignore: ['ios/**']` na triggerach —
    commit czysto kliencki nie odpala builda Next ani deployu na Vercel
    (deploy web przy zmianie tylko w `ios/` byłby no-opem palącym minuty).
  - Wyjątek świadomy: zmiany w `src/lib/api/contracts/` MUSZĄ odpalać i web
    CI, i job kontraktów (A.3) — kontrakty żyją w `src/`, więc paths-ignore
    ich nie tłumi. To jest właśnie powód, dla którego schematy mieszkają w
    `src/`, a nie w `ios/`.
  - Nowy job `contracts` (ubuntu, nie macOS — codegen to Node): regeneracja +
    `git diff --exit-code`. Pełny build Swift w CI to macOS runner i mnożnik
    minut — świadomie POZA CI na start (część B.5).
- **`pnpm lint` / `typecheck` / `test` ignorują `ios/`:** w `ios/` nie ma
  plików `.ts`, więc `tsc` (include: `src/`) i Vitest nic nie zobaczą; do
  flat-configu ESLint dopisać `ignores: ['ios/**']` jawnie — nie polegać na
  tym, że „nie ma czego lintować", bo pierwszy `*.md`/`*.json` pod `ios/`
  potrafi wciągnąć pluginy. Analogicznie `ios/**` poza zasięgiem
  `serwist`/`next build` (i tak nie skanują rootu, ale zapis w planie = test
  akceptacyjny: `pnpm build` po dodaniu `ios/` przechodzi bez zmian czasu).

## A.3 Codegen kontraktów — warunek wejścia, nie „potem"

Klient Swift nie deployuje się razem z serwerem; dryf typów między
`LivePayload` a ręcznie przepisanym structem to najbardziej przewidywalna
kategoria bugów tego projektu. Dlatego kontrakty są generowane, a CI łamie
build, gdy wygenerowany plik jest nieaktualny — od PIERWSZEGO endpointu.

- **Źródło prawdy: `src/lib/api/contracts/`** — schematy zod 4 (repo już ma
  zod 4.4), izomorficzne (zero `server-only`, zero importów z db). Tu trafiają:
  `live-payload.ts` (dzisiejszy kształt `LivePayload` przepisany na zod —
  jednorazowy koszt, od tej pory route'y `/api/quotes*` walidują NIM swoje
  odpowiedzi w testach), `bootstrap.ts`, `transactions.ts`, `portfolios.ts`,
  `watchlist.ts`, `series.ts`, `fx.ts`, `instrument.ts`. Handlery z A.5
  używają tych schematów do walidacji wejścia (`safeParse`) — schemat, który
  nie jest używany w runtime, gnije.
- **Pipeline:** `scripts/gen-swift-contracts.mjs` (pnpm script
  `contracts:gen`):
  1. importuje każdy schemat i woła natywne `z.toJSONSchema()` (zod 4 ma to
     w standardzie — bez `zod-to-json-schema`);
  2. skleja definicje w jeden dokument JSON Schema (`$defs` per typ);
  3. przepuszcza przez **quicktype** (`quicktype --src-lang schema --lang
     swift --struct-only ...`) → `ios/StockHODL/Generated/Contracts.swift`
     (structy `Codable`, `snake_case`→`camelCase` przez `CodingKeys`);
  4. nagłówek pliku: „GENERATED — edytuj schematy w src/lib/api/contracts/".
  quicktype wchodzi jako devDependency — jedyne nowe narzędzie tej ścieżki.

  **Jak to wyszło w C0 — odstępstwa od powyższego szkicu, z powodami:**
  - punkt 1–2 zamienione na **jedno** przejście przez `z.registry()`.
    Konwertowanie każdego schematu osobno dawało quicktype'owi kilka
    niezależnych grafów, więc ten sam kształt lądował jako `LiveHoldingClass`,
    `PurpleCachedPrice` i tak dalej. Rejestr generuje `$ref`-y i typy są
    pojedyncze (503 linie zamiast 871);
  - nazwy typów biorą się z `title` w JSON Schema, nie z klucza `$defs` —
    stąd `.meta({ title: ... })` przy enumach inline w kontraktach;
  - **nie** `--just-types`: ta flaga gubi rawValues w enumach, więc
    `MarketStatus.earlyTrading` niosłoby `"earlyTrading"` i nie zdekodowało
    `"early_trading"` z drutu. Właściwa flaga to `--no-initializers`;
  - generowane są wyłącznie kształty **odpowiedzi**. Requesty zostają ręczne:
    dryf odpowiedzi jest cichy (pole znika → `nil` → ekran pokazuje „—"),
    dryf requestu jest głośny (400 z nazwą pola), a schematy wejściowe niosą
    transformy, których JSON Schema nie opisuje.

- **Tokeny (`pnpm tokens:gen`):** `src/styles/tokens.css` →
  `ios/StockHODL/Generated/Tokens.swift`. Emitowane są **trójki OKLCH**, nie
  RGB — konwersja siedzi w `Design/OKLCH.swift` i celuje w Display P3.
  Zmierzone, nie założone: `sparkline-loss` (dark), `gain` (light) i
  `sparkline-gain` (light) leżą **poza sRGB** i wewnątrz P3, więc spłaszczenie
  do sRGB w generatorze widocznie by je zgasiło obok przeglądarki na tym samym
  telefonie. Jeden token — `ring` (dark) — wychodzi poza P3 o ~0,04 na kanale
  niebieskim; przeglądarka clipuje go tak samo, więc jest to zapisane w teście
  z nazwy, a nie po cichu tolerowane.
- **Wygenerowany Swift jest commitowany** (build Xcode nie zależy od Node),
  a job `contracts` w CI robi: `pnpm contracts:gen && git diff --exit-code --
  ios/StockHODL/Generated/` — nieaktualny plik = czerwony PR. To jest cała
  ochrona przed dryfem i działa na ubuntu.
- **Kwoty w kontraktach:** decimal-stringi pozostają `string` w JSON Schema —
  quicktype wygeneruje `String`. Konwersja do `Decimal` dzieje się wyłącznie
  w ręcznej warstwie mapującej (A.4), nigdy w generowanych structach.
  Wersjonowanie: kontrakty opisują `/api/mobile/v1/*`; zmiana łamiąca = nowy
  plik w `contracts/v2/`, stary żyje, dopóki żyje build w TestFlight.

## A.4 Pieniądze w Swift — odtworzenie dyscypliny `money.ts`

To bezpośrednio dotyka **zasady nr 1 z CLAUDE.md** (żadnego float money math).
Jej odpowiednik w Swift:

- **`ios/StockHODL/Money/Money.swift`** — lustrzane odbicie
  `src/lib/money.ts`: `func dec(_ s: String) -> Decimal?` przez
  `Decimal(string: s, locale: Locale(identifier: "en_US_POSIX"))` —
  locale POSIX jawnie, bo `Decimal(string:)` bez niego parsuje wg locale
  urządzenia i na pl-PL potraktuje kropkę dziesiętną jak śmieć; `pctChange`
  zwracające `Decimal?` (nil przy bazie 0 — nigdy „0,00%" udające flat);
  `enum Direction { gain, loss, neutral }` + `directionOf(_:)`.
- **Zakaz `Double` na cenach/ilościach/FX:** kwota istnieje w appce wyłącznie
  jako `String` (transport, generated structy) albo `Decimal` (arytmetyka).
  Egzekwowanie: (a) warstwa mapująca Generated→model domenowy jest jedynym
  miejscem konwersji; (b) test-grep w CI (job `contracts` robi dodatkowo
  `grep -rn 'Double(' ios/StockHODL/ --include='*.swift'` z allowlistą
  jednego pliku — patrz następny punkt) — ten sam duch co preflight #5.
- **Jedyny sanctioned float boundary w appce:** Swift Charts rysuje po
  `Double` (serwer nie ma już żadnej konwersji na float):
  `ios/StockHODL/Charts/PlotPoints.swift` (widget ma własny
  `WidgetPlotPoints.swift`, patrz `docs/context.md` § Design system), konwersja `Decimal` →
  `NSDecimalNumber.doubleValue` TYLKO do geometrii; etykiety i tooltipy
  formatują `Decimal` niesiony obok punktu, nigdy odczyt z osi.
- **Formatowanie pl-PL:** `Decimal.FormatStyle.Currency` /
  `.number.precision(...)` z `Locale(identifier: "pl_PL")` — odpowiedniki
  `fmtMoney` (grupowanie zawsze — odtworzyć decyzję `minimumGroupingDigits`
  z komentarza w `money.ts`), `fmtPct` (`.sign(strategy:
  .always(includingZero: false))` = dzisiejsze `exceptZero`), `fmtQuantity`,
  `splitMoney` (typografia kwota/waluta na kafelkach — pl-PL: waluta po
  ostatnim U+00A0, ten sam kontrakt co w TS).
- **Testy:** `ios/StockHODLTests/MoneyTests.swift` (Swift Testing) —
  przypadki przeniesione 1:1 z **`src/lib/money.test.ts`**: zaokrąglanie
  half-up, pctChange od zera → nil, formaty pl-PL (separator U+00A0, znak
  na dodatnich, „—" dla null), splitMoney na stringu bez separatora.
  Rozjazd między Vitest a XCTest w tych samych przypadkach = bug boundary,
  nie „różnica platform".

  **Zrobione w C0, z jednym odstępstwem:** formatery są pisane ręcznie, a nie
  oparte o `Decimal.FormatStyle`. Powód konkretny: `FormatStyle` ma
  `.grouping(.automatic)` i `.grouping(.never)`, i **nic** co znaczy „always",
  więc `minimumGroupingDigits: 2` z polskiego CLDR przywróciłby na telefonie
  dokładnie tego buga, którego web już naprawił (`4550,59 zł` obok
  `45 500,59 zł`). Przy okazji wyjście przestaje zależeć od tego, jaki CLDR
  przyjedzie z następnym iOS-em. Odziedziczona jest też asymetria znaku:
  `fmtPct` decyduje o znaku **po** zaokrągleniu (−0,004% → „0,00%"), a
  `fmtMoney` zachowuje minus (−0,001 zł → „−0,00 zł") — tak samo jak
  `signDisplay: 'exceptZero'` vs `'auto'` w Intl.

  **Uczciwie o weryfikacji:** na tej maszynie nie ma zainstalowanego runtime'u
  symulatora, więc `xcodebuild test` nie ma na czym uruchomić bundla. Oba
  targety **kompilują się** na `iphonesimulator` (`xcodebuild build`), a 38
  testów (Money 24, OKLCH 8, Contracts 6) faktycznie **przechodzi** — puszczone
  przez pakiet SPM na macOS wskazujący dowiązaniami na te same pliki
  źródłowe. Pierwsze prawdziwe `xcodebuild test` należy do C1, po doinstalowaniu
  runtime'u.

  **Dług spłacony (2026-08-17, koniec C1):** runtime iOS 26.5 zainstalowany,
  `xcodebuild test` przechodzi na symulatorze — 76 testów, 7 zestawów,
  `** TEST SUCCEEDED **`. Od teraz to jest kanoniczny sposób puszczania testów;
  pakiet SPM był protezą na czas braku runtime'u. Uwaga na przyszłość: pobranie
  runtime'u to 8,52 GB, a pierwszy rozruch symulatora potrafi dobić dysk do
  100% i zdławić całą maszynę.

  Poniższy akapit opisuje stan sprzed spłaty i zostaje, bo tłumaczy, dlaczego
  ceremonia jest rozdzielona protokołem: pliki, które importują UIKit/SwiftUI
  (`PasskeyController`, widoki, `Color+Tokens`), nie wchodzą do pakietu SPM,
  więc jedyne, co je sprawdza, to kompilacja. Dlatego cała logika ceremonii jest
  z nich celowo wyprowadzona — `PasskeyAsserting` to protokół, a jego jedyna
  prawdziwa implementacja nie zawiera żadnej decyzji poza mapowaniem błędów
  systemu. Zamknięcie długu: `xcodebuild test` po instalacji runtime'u
  (Xcode → Settings → Components).

## A.5 Warstwa API `/api/mobile/v1/*` — wspólny fundament

Ta warstwa jest w ~90% niezależna od wyboru klienta — była identyczna w
wariancie Expo i przeżyje każdą przyszłą zmianę klienta. Jedyne, co jest
swift-specyficzne, to codegen z A.3 (i on też konsumuje neutralny JSON
Schema).

Zasada: **żadnej nowej logiki w endpointach.** Handler = guard sesji (ten sam
co dziś) + `safeParse` schematem z `contracts/` + wywołanie tej samej funkcji
z `src/lib/**`, którą woła Server Action. Gdzie logika siedzi w pliku akcji —
najpierw ekstrakcja do `src/lib/`, akcja i route stają się cienkimi
wrapperami. Wszystkie kwoty jako decimal-stringi. To świadome ugięcie
konwencji „do not add a REST layer" — do zapisania w `docs/context.md`.

Reużywane bez zmian: `/api/symbols/search`, `/api/logo/[symbol]`.

~~Reużywane bez zmian: `/api/quotes`, `/api/quotes/stream`,
`/api/quotes/watchlist` (+stream).~~ **Nieprawda, wykryte w C2 (2026-08-18).**
`src/proxy.ts` jest bramką **na ciasteczko** i jedynym wykluczonym prefiksem
jest `/api/mobile/`. Klient z samym `Authorization: Bearer` dostaje pod tymi
adresami 307 na `/login`, a więc HTML tam, gdzie spodziewa się JSON-a — co
klient zobaczy jako błąd dekodowania, nie jako brak autoryzacji. Rozszerzanie
listy wykluczeń wymieniłoby udokumentowaną granicę deny-by-default na
oszczędność jednego pliku, więc zamiast tego powstały bliźniaki w przestrzeni
mobilnej: **`/api/mobile/v1/live`** i **`/api/mobile/v1/live/stream`**, oba
cienkie — składają payload tymi samymi funkcjami (`getHoldingsView`,
`loadHoldingsInputs` + `composeLivePayload` + `quoteStreamResponse`), więc
web i telefon nie mają jak się rozjechać. Ekran watchlisty będzie potrzebował
tego samego zabiegu.

Do dodania (zakres v1 z A.8):

| Endpoint | Metody | Wrapper na |
|---|---|---|
| `/api/mobile/v1/bootstrap` | GET | portfele, instrumenty usera, watchlist, market status — to, co dziś składają Server Components |
| `/api/mobile/v1/transactions` (+`/[id]`) | GET, POST, PATCH, DELETE | `transactions/actions.ts` → ekstrakcja do `src/lib/transactions/` |
| `/api/mobile/v1/portfolios` (+`/[id]`) | GET, POST, PATCH, DELETE | `portfolios/actions.ts` |
| `/api/mobile/v1/watchlist` (+`/[id]`) | POST, DELETE | `watchlist/actions.ts` |
| `/api/mobile/v1/fx-rate` | GET | `getFxRate` (D-1 NBP; klient nigdy nie dotyka `api.nbp.pl` — server-mediated obowiązuje NBP jak Massive) |
| `/api/mobile/v1/series/portfolio` | GET | `getPortfolioSeries` |
| `/api/mobile/v1/series/price/[symbol]` | GET | `getPriceSeries`; symbol walidowany przeciw instrumentom/watchliście usera, obcy → 404 |
| `/api/mobile/v1/instrument/[symbol]` | GET | to, co składa `holdings/[ticker]/page.tsx` |

Reguła „market data server-mediated" przeżywa w najczystszej formie: klient
Swift zna dokładnie jeden host. `STOCK_API`, Massive i NBP zostają wyłącznie
po stronie serwera.

## A.6 Auth — natywne passkeys przez AuthenticationServices

Bramki allowlisty w `src/lib/auth.ts` zostają nietknięte (non-negotiable #5);
klient natywny to nowy konsument tej samej, jedynej metody logowania.

1. **Klient:** `ASAuthorizationPlatformPublicKeyCredentialProvider(
   relyingPartyIdentifier: "sawa-finance.vercel.app")` — asercja istniejącego
   passkeya z iCloud Keychain (ten sam, którym logujesz się na webie —
   rpID się zgadza, więc klucz JEST współdzielony). Face ID → podpis →
   sesja. Enrollment nowych kluczy zostaje na webie (poza v1).
2. **Ceremonia po JSON:** Better Auth passkey plugin wystawia endpointy
   generate/verify pod `/api/auth/passkey/*`. Cienki klient Swift:
   pobierz challenge → `ASAuthorizationController` → spakuj
   `rawClientDataJSON` / `rawAuthenticatorData` / `signature` / `credentialID`
   do base64url w formacie WebAuthn JSON, który plugin weryfikuje. To jest
   dłubanina (base64url vs base64, dokładne nazwy pól) — zaplanowana jako
   osobna sesja, nie „przy okazji".
3. **Associated Domains:** entitlement
   `webcredentials:sawa-finance.vercel.app` w targecie + plik AASA z
   produkcji: nowy route handler
   `src/app/.well-known/apple-app-site-association/route.ts`
   (`webcredentials.apps = ["<TEAMID>.com.robertandrosz.stockhodl"]`),
   public — **wyjątek w `src/proxy.ts`** (dziś proxy przekierowuje wszystko
   niezalogowane na `/login`), `Content-Type: application/json`, bez
   redirectu. Wymaga płatnego konta Apple (darmowy personal team nie ma tej
   capability — część B).
4. **Sesja: bearer token w Keychain, nie cookie.** URLSession umie cookies,
   ale `__Host-` cookie w `HTTPCookieStorage` to stan ukryty poza kontrolą
   appki (czyszczenie, migracje, debug). Zamiast tego plugin `bearer()`
   Better Autha po stronie serwera: po weryfikacji passkeya klient dostaje
   token sesji, trzyma go w **Keychain** (`kSecAttrAccessible
   AfterFirstUnlock`), wysyła w `Authorization: Bearer` na każdym wywołaniu
   `/api/mobile/v1/*` i SSE. Wylogowanie = revoke po stronie serwera + kasacja
   z Keychain + kasacja snapshotu (A.7).
   **Ustalone w S2, wiążące dla C1:** plugin wpięty jako
   `bearer({ requireSignature: true })`, więc do Keychain idzie **podpisana**
   wartość z nagłówka odpowiedzi `set-auth-token` (`token.signature`), nie
   samo `session.token`. Surowy token serwer odrzuci.
   **Dług z security review S2 — ZAMKNIĘTY JESZCZE W S2, w tym samym commicie
   co plugin (przegląd zablokował deploy: ryzyko zaczyna się w chwili wdrożenia
   `bearer()`, a nie dopiero gdy telefon istnieje):** after-hook pluginu ma
   matcher `() => true`, więc
   `set-auth-token` wychodzi na KAŻDEJ odpowiedzi Better Autha ustawiającej
   cookie sesji — także przy logowaniu passkeyem na webie i przy dobowym
   odświeżeniu `updateAge`. Podpisany token sesji, dotąd osiągalny wyłącznie
   jako `httpOnly __Host-` cookie, staje się czytelny dla same-origin JS z
   `response.headers`; przy `script-src 'unsafe-inline'` wstrzyknięty skrypt
   wyniósłby 7-dniowe poświadczenie, którego żadna flaga już nie chroni.
   Zdalnie samo z siebie niewyzwalalne. Fix — ZROBIONY: w
   `src/app/api/auth/[...all]/route.ts` `set-auth-token` i
   `Access-Control-Expose-Headers` są zdejmowane z odpowiedzi, chyba że
   request deklaruje się jako natywny — nagłówkiem `x-stockhodl-client: ios`
   (`src/lib/api/mobile/native-client.ts`), wysyłanym przez klienta iOS na
   każdym wywołaniu **łącznie z logowaniem** (na tym etapie nie ma jeszcze
   tokenu, więc bramka po `Authorization` zablokowałaby enrollment).
   Sam nagłówek to za mało — same-origin skrypt też umie go ustawić — więc
   `isNativeClient` dodatkowo wymaga BRAKU `Sec-Fetch-Site`: przeglądarka
   dokłada go do każdego fetch/XHR i nie da się go stłumić (forbidden header
   name), a `URLSession` nie wysyła go nigdy.
   **Wiążące dla C1:** klient iOS MUSI wysyłać `x-stockhodl-client: ios` od
   pierwszego żądania enrollmentu — bez niego nie zobaczy `set-auth-token` i
   nie będzie miał czego zapisać w Keychain. Jeśli kiedyś logowanie pójdzie
   przez `WKWebView` zamiast `URLSession`, ten warunek je zablokuje (WebView
   wyśle `Sec-Fetch-Site`) — wtedy trzeba innego sygnału, nie rozluźnienia
   tego.
5. **Zmiany w `src/lib/auth.ts`, wprost:** dodać plugin `bearer()`;
   sprawdzić, czy `passkey({ origin })` przyjmuje natywny origin asercji —
   po weryfikacji Associated Domains Apple raportuje origin domeny
   (`https://sawa-finance.vercel.app`), więc zmiana może być zbędna;
   **zweryfikować na realnej asercji w C1, nie zakładać.** `rpID` bez zmian.
   Diff dotyka auth ⇒ obowiązkowy `sf-security-reviewer` (preflight #4).
6. **Życie sesji:** 7 dni sliding oznacza re-login po tygodniu nieużywania.
   **Decyzja podjęta w C1: zostaje bez zmian.** Podniesienie `expiresIn` jest
   globalne — wydłużyłoby okno użyteczności skradzionego poświadczenia także
   webowi, a jedyne, co kupuje, to jeden Face ID tygodniowo w aplikacji, która
   i tak prosi o Face ID przy każdym logowaniu. Osobnej polityki dla mobile
   nadal nie robimy. Warto wiedzieć, jak to wygląda w praktyce: token trzyma
   się w Keychainie do skutku, przy starcie sprawdzany jest przez
   `get-session`, a odmowa (200 z ciałem `null`) go kasuje — więc „wygasła
   sesja" objawia się ekranem logowania, nie błędem.

### Jak C1 wyszło naprawdę (2026-08-17)

Zaimplementowane i przetestowane: `Auth/` (Base64URL, WebAuthn DTO,
`PasskeyAsserting` + `PasskeyController`, `TokenStore` + Keychain, `AuthClient`,
`AuthStore`), `Networking/` (`AppConfig`, `APIClient`), ekrany logowania i
wylogowania, `ios/Config/` (xcconfig + dwa Info.plisty + entitlements).
38 nowych testów, razem 76.

Odchylenia od szkicu powyżej i rzeczy, których szkic nie przewidział:

- **Ceremonia jest cookie-bound i szkic tego nie mówił.** Plugin zapisuje
  challenge po stronie serwera pod losowym tokenem i oddaje ten token w
  **podpisanym ciasteczku**; `verify-authentication` je odczytuje. Klient musi
  więc przenieść ciasteczka z pierwszego wywołania do drugiego ręcznie. To
  jedyne ciasteczko, jakiego ten klient dotyka — `URLSession` ma wyłączony
  cookie storage w całości, zgodnie z A.6.4. Brak tego przeniesienia daje błąd
  „challenge not found", który brzmi jak wygaśnięcie, a jest brakiem nagłówka.
- **`Origin` wysyłamy jawnie na każdym zapisie.** `isCrossSiteWrite`
  przepuszcza request z `Authorization` i bez `Cookie`, ale to jest furtka
  awaryjna, nie licencja — klient podaje własny origin, budowany z części URL-a,
  żeby ukośnik na końcu w xcconfigu nie zamienił się w 401 bez wyjaśnienia.
- **`APIClient` dostaje wstrzykiwany transport zamiast `URLProtocol`.** Stub na
  `URLProtocol` przenosi `httpBody` do strumienia i mieszka w globalnym stanie —
  akurat te dwie rzeczy, które trzeba tu asertować, stają się przez to
  niewygodne i nierównoległe.
- **`AuthStore.live()` mieszka w osobnym pliku w `App/`.** Wystarczy jedna
  wzmianka o `PasskeyController`, żeby plik przestał się kompilować poza
  targetem iOS — a to jest dokładnie ten plik, który chcemy testować bez
  symulatora.
- **Entitlementy nie trafiają do podpisu na symulatorze** bez zespołu i profilu
  (`.xcent` wychodzi pusty). To oczekiwane, nie usterka: uzupełni się samo po
  ustawieniu `DEVELOPMENT_TEAM`.

**Zamknięte na urządzeniu (2026-08-17, tego samego dnia):**

1. ✅ `DEVELOPMENT_TEAM = KURWX5TYSZ` w `ios/Config/Base.xcconfig`.
2. ✅ `APPLE_APP_ID` w produkcji Vercela; AASA odpowiada `200` z
   `{"webcredentials":{"apps":["KURWX5TYSZ.com.robertandrosz.stockhodl"]}}`,
   bez przekierowania, `content-type: application/json`.
3. ✅ **Prawdziwa asercja przeszła** — passkey wydany w przeglądarce podpisał
   challenge na iPhonie, serwer przyjął, `set-auth-token` wylądował w
   Keychainie. `passkey({ origin })` nie wymagało tablicy originów: Apple
   raportuje dokładnie `https://sawa-finance.vercel.app`, więc pojedynczy
   origin z A.6.5 jest poprawny i zostaje.
4. ✅ `xcodebuild test` na symulatorze iOS 26.5: 76 testów, 7 zestawów,
   `** TEST SUCCEEDED **`. Pierwszy przebieg przez prawdziwy target aplikacji,
   nie przez zastępczy pakiet SPM.

**Czego szkic nie przewidział, a kosztowało pierwszy nieudany login:**
Debug wskazywał na `http://localhost:3000`, co na symulatorze jest poprawne
(dzieli stos sieciowy z Makiem), a na telefonie oznacza sam telefon — żądanie
umierało w transporcie przed arkuszem Face ID i wyglądało jak odrzucone
poświadczenie, bo `AuthStore` pokazuje jedno mgliste zdanie na każdy błąd.
Adres jest teraz warunkowy: `API_BASE_URL[sdk=iphoneos*]` celuje w produkcję.
Adres LAN Maca **nie** jest tu alternatywą — `rpID` wyprowadzamy z hosta, a pod
`192.168.x.x` nie ma AASA. Do tego `#if DEBUG print("[auth] sign-in failed:")`,
żeby następna awaria nie była nierozróżnialna od tej.

## A.7 Live, dane i wydajność po stronie Swift

- **`@Observable` zamiast memo comparators.** Model `LiveStore` trzyma
  payload; widoki czytają tylko pola, które renderują — SwiftUI inwaliduje
  per-odczyt, więc kafelek, którego cena się nie zmieniła, nie renderuje się
  wcale. Cała klasa problemów, dla której powstały `ticker-tile-equal.ts` /
  `holding-card-equal.ts`, znika strukturalnie; ich testy zostają po stronie
  web.
- **SSE przez `URLSession.bytes(for:)`:** `for try await line in
  bytes.lines`, parsowanie `data:` → tick → aktualizacja store. Nagłówek
  `Authorization` z Keychain. SSE na Vercelu ma ograniczony lifetime — port
  logiki reconnect z klienta webowego (`use-quote-stream.ts` jako spec).
  `scenePhase == .background` → zamknij strumień; `.active` → świeży REST
  baseline + reconnect (odpowiednik Page Visibility).
- **Poll policy przeniesiona z `src/lib/holdings/poll-policy.ts`:** czysta
  logika (status rynku → interwał albo cisza) przepisana do
  `PollPolicy.swift` z testami odtworzonymi z `poll-policy.test.ts` — rynek
  zamknięty = zero requestów, bateria i rachunek za funkcje dziękują.
- **Swift Charts zamiast Recharts:** `Chart` + `LineMark`/`AreaMark` +
  `RuleMark` (scrubbing), pasma extended-hours jako `RectangleMark` z tagów
  `p: 'pre' | 'post'` — serwer już je wylicza (`session-phase.ts`), klient
  tylko rysuje. Semantyka spójnej trójki i extended-hours przychodzi z
  serwera gotowa — klient jej NIE reimplementuje.
- **Cache warstwy danych:** ostatni `LivePayload` + bootstrap serializowane
  (JSON) do **kontenera App Group** z instantem pobrania; na starcie render
  z cache natychmiast, pasek „Dane z HH:MM" gdy sieć niedostępna
  (odpowiednik uczciwości `network-reachability.ts`: 2 nieudane requesty →
  unreachable, nie sam brak Wi-Fi ikonki). Offline read-only — żadnych
  kolejkowanych mutacji (decyzja z 2026-08-16 obowiązuje też tu).
- **Zimny start Vercela:** pierwszy request po bezczynności może mieć 1–2 s
  narzutu. Mitygacja: snapshot z App Group renderuje się od razu,
  `/bootstrap` i `/api/quotes` lecą RÓWNOLEGLE (`async let`), nie kaskadą;
  bez sztucznego keep-warm crona pod jedno urządzenie.
- **Logotypy:** `/api/logo/[symbol]` przez `URLCache` (ETag/Cache-Control
  dołożyć w route, jeśli brak) — bez bibliotek obrazkowych.
- **Tabular figures:** `.monospacedDigit()` na każdej kolumnie liczb —
  odpowiednik klasy `.tabular`; bez tego kolumny skaczą przy każdym ticku.

## A.8 Zakres v1, co odpada, i co z widgetami

Ekrany v1: **Holdings (scope chips, summary, karty), instrument (nagłówek
live, wykres, transakcje instrumentu), transakcje (lista + dodaj/edytuj/usuń
z symbol search i FX autofill), watchlist, profil-lite (wylogowanie).**

NIE w v1:

- ~~**Options, dividends, news, dashboard, screenshot import**~~ — wszystkie
  weszły. Dashboard i options w C7–C9
  (2026-08-18, plans/2026-08-18-ios-dashboard-and-options.md), dividends, news
  i screenshot import zaraz po nich, a **zapisy dywidend, zarządzanie
  portfelami, wykres portfela z przełącznikiem Value/Return, świece,
  akcje na ekranie instrumentu i ekran ustawień — 2026-08-18** w jednym
  przelocie domykającym różnice web→telefon. Jedyną częścią wymagającą pracy
  serwerowej były zapisy dywidend, i to jako ekstrakcja do
  `src/lib/dividends/mutations.ts`, nie jako nowa logika: rekord, z którego
  użytkownik może rozliczyć podatek, nie może mieć dwóch implementacji.
- **Enrollment passkeyów z telefonu** — asercja tak, rejestracja nowych
  kluczy zostaje na webie. **PRZEGLĄD kluczy wszedł** (2026-08-18): Profil
  pokazuje listę zarejestrowanych passkeyów i pozwala usunąć — ale nigdy
  ostatniego. Reguła „nie ostatni" zjechała do
  `src/lib/passkeys/manage.ts`, wspólnego dla weba i telefonu: wcześniej żyła
  w wyłączonym przycisku, czyli w podpowiedzi, a nie w regule — a jej awaria
  to nie zła liczba na ekranie, tylko konto, do którego nikt się nie zaloguje.
  Rejestracja to ceremonia WebAuthn, nie zapis JSON, więc zostaje poza v1.
- **Push / background refresh** — wymagają APNs i infrastruktury serwerowej,
  której nie ma; BGAppRefreshTask jest niedeterministyczny, a dane i tak są
  15 min opóźnione. Rozważyć w v2 razem z alertami.
- **Light mode** — v1 dark-only (design target repo); tokeny generowane z
  `src/styles/tokens.css` małym skryptem (to samo źródło kolorów — duch
  non-negotiable #2). Ekran ustawień na telefonie świadomie NIE ma sekcji
  „Appearance": przełącznik, który nic nie robi, jest gorszy niż jego brak.
- **Widgety / Live Activities — realny cel, ale poza v1.** Uzasadnienie:
  widget bez działającego rdzenia to widget pokazujący nic; Live Activities
  wymagają przemyślenia częstotliwości aktualizacji (push albo budżet
  odświeżeń) — osobny plan. **Co v1 robi, żeby im nie zaszkodzić:**
  (a) **App Group od pierwszego dnia** (`group.com.robertandrosz.stockhodl`)
  i snapshot payloadu zapisywany właśnie tam — przyszły widget czyta ten sam
  plik bez refaktoru; (b) bearer token w Keychain z access group
  współdzielonym z przyszłą extension; (c) formatowanie i `Money.swift`
  w osobnym module-katalogu, żeby extension mógł go wciągnąć bez ciągnięcia
  całej appki.
- Reguła „both shells, same pass" nie obejmuje `ios/` — trzecia powierzchnia;
  do odnotowania w `docs/context.md` przy S1.

## A.9 Kamienie milowe i nakład (sesje robocze)

Etapy **serwerowe (S)** są wspólne i od Swifta niezależne — przechodzą pełny
rygor repo (cztery gates, security review przy auth/proxy). Etapy
**klienckie (C)** żyją w `ios/` i webu nie ruszają.

| Etap | Zakres | Sesje |
|---|---|---|
| ~~**S1 — kontrakty + API**~~ ✅ | `src/lib/api/contracts/` (zod), ekstrakcje z `actions.ts` do `src/lib/`, `/api/mobile/v1/*`, wpis do `docs/context.md`; testy route'ów walidujące odpowiedzi schematami | 3–4 |
| ~~**S2 — auth serwerowo**~~ ✅ | plugin `bearer()`, AASA route + wyjątek w `proxy.ts`, weryfikacja configu `passkey({ origin })`; security review | 1–2 |
| ~~**C0 — szkielet + codegen**~~ ✅ | `ios/` + projekt Xcode (synchronized folders), `.gitignore`, ESLint ignores, `contracts:gen` + quicktype + job CI z `git diff --exit-code`, `Tokens.swift` z `tokens.css`, `Money.swift` + testy portowane z `money.test.ts` | 2–3 |
| ~~**C1 — auth end-to-end**~~ ✅ *(zweryfikowane na urządzeniu 2026-08-17)* | ceremonia passkey (challenge → ASAuthorization → verify), Keychain, wylogowanie z purge; wymaga płatnego konta (Associated Domains) i ścieżki z części B | 2–3 |
| ~~**C2 — Holdings live**~~ ✅ *(zweryfikowane na urządzeniu 2026-08-18)* | bootstrap+quotes równolegle, snapshot w App Group, scope chips, summary, lista kart, SSE + poll policy + scenePhase | 3–4 |
| ~~**C3 — instrument + wykresy**~~ ✅ *(kod + testy; próba na urządzeniu przed dystrybucją)* | ekran instrumentu, Swift Charts (zakresy, scrubbing, pasma extended-hours), range preference w `UserDefaults` | 3–4 |
| ~~**C4 — transakcje**~~ ✅ *(kod + testy; próba na urządzeniu przed dystrybucją)* | lista, formularz (symbol search, FX autofill), edycja/usuwanie, walidacje wg `src/lib/validation.ts` jako spec | 2–3 |
| ~~**C5 — watchlist + profil + szlif**~~ ✅ *(kod + 177 testów; przegląd na urządzeniu przed dystrybucją)* | watchlist CRUD + live, profil/wylogowanie, offline banner, przegląd wydajności na urządzeniu, bug pass | 2–3 |
| ~~**C6 — parytet wizualny**~~ ✅ *(nieplanowany; kod + testy)* | logotypy (`TickerLogo` + `LogoLoader` + twin `/api/mobile/v1/logo`), hierarchia karty holdingu wg `holding-card.tsx`, summary z etykietami, `MarketStatusBar` z odliczaniem, jeden `ExtendedMoveView` zamiast trzech kopii `PRE`/`POST` | 1–2 |
| ~~**C7 — powłoka + Dashboard**~~ ✅ *(2026-08-18)* | tab bar z czterema slotami webowego `NAV`, górny pasek z `BullMark` + profil (sheet), `AppChrome` z tokenów, `DashboardView` nad ISTNIEJĄCYM `LiveStore` (zero nowych requestów), port `holdings-sort.ts` + `SortMenu` na obu ekranach | 1–2 |
| ~~**S3 — drzwi do opcji**~~ ✅ *(2026-08-18)* | `contracts/options.ts` + anti-drift test, ekstrakcje `portfolio-series.ts` i `mutations.ts` z `actions.ts`, pięć route'ów `/api/mobile/v1/options*` i `/series/options`, wpis do `docs/context.md` | 1–2 |
| ~~**C8 — opcje (odczyt)**~~ ✅ *(2026-08-18)* | `OptionsStore` (poll 60 s, bramka `scenePhase` + rynku), karty z grekami, toggle wygasłych, wykres na pięciu zakresach, ekran kontraktu, sekcja opcji na Dashboardzie; uogólnione `RangeTabs`/`SortMenu`/`TileFrame` zamiast kopii | 2–3 |
| ~~**C9 — opcje (zapis)**~~ ✅ *(2026-08-18)* | kaskada dodawania (underlying → expiry → call/put → strike, debounced), edycja LOTU (identity odrzucana schematem), usuwanie z potwierdzeniem nazywającym konkretny zakup | 2–3 |

**Suma: ~18–26 sesji** (+1–2 na C6, wykryty dopiero na urządzeniu: appka
działała i nie wyglądała jak produkt — tokeny były te same, hierarchia nie). Ryzyka wprost: (1) **C1** — ręczne spięcie formatu
WebAuthn JSON między AuthenticationServices a Better Auth (base64url,
nazwy pól) to najbardziej prawdopodobne miejsce utknięcia; ceremonia jest
jednak standardowa i po stronie Apple stabilna — to dłubanina, nie hazard;
(2) dryf kontraktów — trzymany w ryzach przez A.3 od pierwszego PR;
(3) parsowanie `Decimal(string:)` z locale — przykryte testami z A.4 zanim
cokolwiek od tego zależy.

---

# CZĘŚĆ B — na iPhone'a, wersja deweloperska, „po linku"

## B.1 Wymagania

- **Mac jest na ścieżce krytycznej** — to kluczowa zmiana względem wariantu
  Expo (nie ma EAS budującego w chmurze za darmo). Każdy build instalowalny
  na telefonie powstaje w Xcode na tym Macu (albo na płatnym runnerze/Xcode
  Cloud — B.5).
- **Xcode 26.x** (od kwietnia 2026 uploady do App Store Connect wymagają SDK
  iOS 26) → **macOS 15.6+**. Aktualizację Xcode zrobić przed C0, nie w
  trakcie C1.
- iPhone z iOS ≥ deployment target (proponuję iOS 17, dla pełnego
  `@Observable` i wygodnego API passkeys; telefon z 2024+ spełnia z zapasem).
- Płatne konto Apple Developer — patrz B.2; **bez niego nie ma Associated
  Domains, czyli nie ma natywnych passkeys** — to nie jest opcjonalny wydatek
  w tym planie.

## B.2 Konto: darmowe Apple ID vs Apple Developer Program

| | Darmowe Apple ID (personal team) | Developer Program (99 USD/rok) |
|---|---|---|
| Instalacja | tylko kablem przez Xcode (lub AltStore/Sideloadly) | TestFlight, Ad Hoc po linku, kabel |
| Ważność builda | **7 dni** | TestFlight 90 dni; Ad Hoc do wygaśnięcia profilu (≤1 rok) |
| Capabilities | **brak Associated Domains** (i push, i App Groups współdzielonych sensownie) | pełne |
| „Po linku" | nie istnieje | TestFlight lub itms-services:// |

**Jak kupić Developer Program, konkretnie:**

1. Wejdź na **developer.apple.com/programs/enroll**. Potrzebny Apple ID z
   włączonym **2FA** (bez 2FA enrollment nie ruszy).
2. Typ członkostwa: **Individual** — nie Organization (Organization wymaga
   numeru D-U-N-S i weryfikacji firmy; dla jednej osoby to czysty koszt).
3. Weryfikacja tożsamości: najwygodniej przez **aplikację Apple Developer na
   iPhonie** (App Store → „Apple Developer" → Enroll) — poprosi o zdjęcie
   dokumentu tożsamości i selfie. Ścieżka webowa istnieje, ale bywa wolniejsza.
4. Płatność: **99 USD/rok**, rozliczane w walucie lokalnej (w PL ~430–480 zł
   zależnie od kursu i VAT), **autoodnawialne** — wyłącz autoodnawianie albo
   wpisz przypomnienie, świadoma decyzja.
5. Czas oczekiwania na aktywację: **zwykle 24–48 h**, bywa dłużej (weryfikacja
   ręczna). Dlatego enrollment odpalamy PRZED C0, nie gdy blokuje C1.
6. Przy Individual nazwa dewelopera widoczna publicznie to **imię i
   nazwisko** — bez znaczenia w tym planie, bo nie celujemy w App Store.

## B.3 Ścieżki „po linku"

### a) TestFlight — internal testing (rekomendacja)

**Internal testing NIE przechodzi App Review** — Beta App Review dotyczy tylko
testerów zewnętrznych. Tester wewnętrzny = użytkownik konta w App Store
Connect (Ty, jako Account Holder). Build po uploadzie przechodzi tylko
automatyczne processing (minuty do ~1 h) i jest instalowalny z appki
TestFlight. Plusy: zero UDID, auto-update, crash logi. Minusy: 99 USD/rok,
build wygasa po 90 dniach, wymaga rekordu appki w App Store Connect mimo
braku publikacji.

### b) Ad Hoc + manifest.plist + itms-services:// (krótko)

UDID telefonu → rejestracja urządzenia w portalu → profil Ad Hoc → Archive →
export „Ad Hoc" (Xcode generuje `manifest.plist`) → `.ipa` + manifest
hostowane po HTTPS (np. osobny mini-projekt na Vercelu, bez deployment
protection na tych ścieżkach) → link
`itms-services://?action=download-manifest&url=https://.../manifest.plist` →
na telefonie zaufać profilowi w Ustawieniach. Ograniczenia: 100 urządzeń/rok,
**certyfikat wygasa po roku i appka przestaje startować**, każdy update to
ręczna podmiana plików, zero crash reportingu. Sensowny tylko, gdyby App
Store Connect z jakiegoś powodu odpadł.

### c) Sideload: Xcode kablem / AltStore / Sideloadly (krótko)

Kabel + Run z Xcode to i tak codzienna pętla deweloperska w C1–C5. AltStore/
Sideloadly automatyzują 7-dniowe przepodpisywanie na darmowym koncie — ale
darmowe konto nie ma Associated Domains, więc w tym planie to ślepa uliczka.

### Rekomendacja dla jednego użytkownika z jednym iPhonem

**Developer Program + TestFlight internal.** Dev pętla kablem z Xcode;
„wersja do noszenia w kieszeni" przez TestFlight co kilka tygodni.

## B.4 Setup krok po kroku (Xcode)

1. Enrollment (B.2) — najpierw, bo czeka się dobę–dwie. Zanotuj **Team ID**.
2. Xcode → Settings → Accounts → zaloguj Apple ID, wybierz team.
3. Target StockHODL → Signing & Capabilities:
   - Bundle Identifier: `com.robertandrosz.stockhodl`;
   - **Automatically manage signing** (przy jednej osobie ręczne profile to
     samozadana krzywda) — Xcode założy App ID, certyfikat i profile sam;
   - Capability **Associated Domains**: `webcredentials:sawa-finance.vercel.app`;
   - Capability **App Groups**: `group.com.robertandrosz.stockhodl` (od razu,
     dla przyszłych widgetów — A.8).
4. Dev pętla: telefon kablem (raz: włączyć Developer Mode w Ustawieniach
   telefonu), Run — działa od pierwszego dnia po aktywacji konta.
5. App Store Connect (appstoreconnect.apple.com) → My Apps → **+** → New App:
   platforma iOS, bundle ID z kroku 3, nazwa (np. „StockHODL"), SKU dowolne.
   Nic z pól „do publikacji" nie musi być wypełnione dla internal testing.
6. Build do TestFlight: Product → **Archive** (scheme Release, Any iOS
   Device) → Organizer → **Distribute App** → **TestFlight Internal Only**
   (opcja w Xcode 15+; build z tą dystrybucją nigdy nie trafi do review) →
   Upload. Xcode sam ogarnie podpis dystrybucyjny.
7. App Store Connect → TestFlight → Internal Testing → **+** grupa („Me") →
   dodaj siebie (Account Holder) → zaznacz build po zakończeniu processing.
   Pytania o export compliance: appka używa tylko HTTPS → standardowe
   zwolnienie (ustaw `ITSAppUsesNonExemptEncryption = NO` w Info.plist, żeby
   nie klikać tego przy każdym buildzie).
8. iPhone: zainstaluj **TestFlight** z App Store, przyjmij zaproszenie
   (mail na Apple ID zalogowany w TestFlight) → Install. Kolejne buildy:
   powiadomienie + jeden tap (albo auto-update).

Konfiguracja URL API: **xcconfig per konfiguracja** — `Debug.xcconfig` z
`API_BASE_URL = http://localhost:3000` (+ wyjątek ATS tylko w Debug),
`Release.xcconfig` z `https://sawa-finance.vercel.app`; wartość czytana z
Info.plist, zero hardkodów w kodzie Swift.

## B.5 Automatyzacja — co jest rozsądne, a co przepłacone

Odpowiednik „push do main = deploy" dla iOS jest droższy niż w wariancie
Expo, bo build wymaga macOS:

- **Na start (C0–C5 i pierwsze miesiące): lokalny Archive + upload z
  Organizera.** Dla jednej osoby z jednym telefonem to ~10 minut co kilka
  tygodni. Automatyzowanie tego zanim rytuał zacznie boleć to inwestycja bez
  zwrotu.
- **GitHub Actions z runnerem macOS:** działa (fastlane `build_app` +
  `pilot`, App Store Connect API key w sekretach, import certyfikatu do
  keychain w jobie), ale wprost: **minuty macOS liczą się z mnożnikiem 10×**
  względem Linuxa na prywatnych repo — jeden build to realnie 15–30 min
  runnera, czyli 150–300 „minut" z puli. Do tego utrzymanie certyfikatów w
  CI. Nie na start.
- **Xcode Cloud:** sensowna pierwsza automatyzacja, gdy przyjdzie pora —
  **25 godzin obliczeń/miesiąc w cenie członkostwa**, konfiguracja w Xcode,
  buduje z GitHuba i sam wrzuca do TestFlight; certyfikaty trzyma Apple.
  Ograniczenie: kolejny system CI obok GitHub Actions — akceptowalne, bo
  robi dokładnie jedną rzecz.
- **Job `contracts` (A.3) to nie jest build Swifta** — chodzi na ubuntu w
  istniejącym `ci.yml` i pilnuje dryfu typów na każdym PR niezależnie od
  powyższego.
- Rytm wymuszony przez TestFlight: świeży build co ≤90 dni. Przypomnienie:
  `schedule` w Actions tworzący issue co 10 tygodni — jedna linia YAML,
  zero macOS.

## B.6 Pułapki — lista kontrolna

- **TestFlight 90 dni:** build wygasa i appka odmawia startu. Objaw „po
  urlopie nie działa" to zwykle to. Mitygacja: rytm z B.5.
- **Certyfikat Apple Distribution (1 rok):** przy automatic signing Xcode
  odnowi przy następnym Archive; wpis w kalendarzu na miesiąc przed, żeby
  odnowienie nie zbiegło się z wygaśnięciem builda.
- **ATS/HTTPS:** produkcja na Vercelu spełnia TLS. Dev przeciw
  `http://localhost:3000` wymaga wyjątku ATS **wyłącznie w konfiguracji
  Debug** (osobny Info.plist klucz przez xcconfig) — nigdy w Release.
- **AASA i cache Apple'a:** plik musi być na **domenie produkcyjnej** bez
  redirectu — surowe URL-e `finance-<hash>-….vercel.app` 302 do Vercel SSO
  (deployment protection), więc AASA testować wyłącznie na
  `sawa-finance.vercel.app`. Apple pobiera AASA przez własne CDN i cache'uje
  do ~doby — po zmianie pliku lub entitlementu przeinstalować appkę i nie
  panikować od razu; do debugowania tryb developer
  (`?mode=developer` w entitlement na build debugowy).
- **rpID vs domena:** passkey `rpID = sawa-finance.vercel.app`. Własna domena
  kiedyś = migracja passkeys (nowa rejestracja), nie rename. Decyzję o
  domenie podjąć PRZED C1.
- **Zmiana URL API między dev a prod:** URL jest wpieczony w build (B.4);
  zmiana domeny produkcyjnej = nowy build w TestFlight. Stąd `/v1/` w API
  i zasada: serwer nie łamie kontraktu, dopóki żyje build, który go używa —
  a build potrafi żyć 90 dni.
- **Zaproszenie TestFlight idzie na e-mail Apple ID** — to konto musi być
  zalogowane w TestFlight na telefonie.
- **`vercel --prod` lokalnie nie działa w tym repo** (Root Directory quirk,
  `docs/context.md`) — wszystko serwerowe wchodzi normalnym pushem do `main`.

---

## Pierwsze kroki (kolejność startu)

1. Enrollment w Developer Program (B.2) — odpalić od razu, czeka się 24–48 h.
2. Akceptacja zakresu v1 (A.8) i decyzji o `expiresIn` sesji (A.6.6).
3. S1 (kontrakty + API) — praca w `src/` normalnym rygorem repo; równolegle
   C0 (szkielet Xcode + codegen + `Money.swift` z testami) — C0 nie wymaga
   jeszcze konta, dopiero C1.
4. C1 po aktywacji konta: Associated Domains + pierwsza asercja passkeya na
   urządzeniu.
