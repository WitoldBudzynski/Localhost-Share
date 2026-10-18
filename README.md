# Localhost Share

Aplikacja Node.js do przesyłania plików między komputerem i telefonem w lokalnej sieci. Polski interfejs, kod QR, HTTP i HTTPS, bez konta, chmury i usług zewnętrznych podczas udostępniania.

## Uruchomienie jednym skryptem

Zainstaluj **Node.js 24 lub nowszy z npm** (zalecana aktualna stabilna wersja LTS), otwórz terminal w katalogu projektu i uruchom:

```sh
node start.mjs
```

Możesz również uruchomić `./start.sh` na Linux/macOS albo `start.cmd` na Windows. Skrypt przy pierwszym uruchomieniu instaluje dokładne wersje zależności z `package-lock.json`, kompiluje aplikację i uruchamia serwery. Instalacja wymaga internetu; kolejne uruchomienia z niezmienionym plikiem blokady działają offline. Nie są potrzebne OpenSSL, Python ani kompilator C++.

Domyślna konfiguracja:

- udostępniany katalog: `./shared`, względem bieżącego katalogu terminala; tworzony automatycznie;
- HTTP: port `8080`, HTTPS: port `8443`;
- adres: automatycznie wybrany prywatny adres IPv4 interfejsu sieciowego;
- limit: **1 GB = 1 000 000 000 bajtów na jeden plik**, maksymalnie cztery równoległe wgrywania; interfejs przesyła kolejno;
- certyfikat i klucz: `.localhost-share/cert.pem` i `.localhost-share/key.pem`, poza katalogiem udostępnianym.

Otwórz w komputerze „Panel komputera” wypisany w terminalu. Zeskanuj kod QR telefonem podłączonym do tej samej sieci. Kod QR jest też dostępny bezpośrednio w terminalu. W panelu można przełączyć kod QR pomiędzy HTTP i HTTPS i skopiować link. Każde uruchomienie tworzy nowy losowy kod dostępu; poprzednie linki tracą ważność.

**Zatrzymanie:** `Ctrl+C` w terminalu lub „Zakończ udostępnianie” w panelu otwartym przez `127.0.0.1`. Zatrzymywane są oba serwery, aktywne transfery są przerywane, a bieżące pliki tymczasowe usuwane. Zamknięcie karty przeglądarki telefonu nie kończy procesu Node.js na komputerze.

## Inny katalog, adres lub port

```sh
node start.mjs --dir "/ścieżka/do/plików" --host 192.168.1.20 --port 9000 --https-port 9443
node start.mjs --https-only
node start.mjs --http-only
node start.mjs --help
```

Windows:

```powershell
node start.mjs --dir "D:\Pliki do przesłania" --host 192.168.1.20
```

`--host` musi wskazywać prywatny adres IPv4 istniejącego interfejsu lub `127.0.0.1` do pracy wyłącznie na komputerze. Przy kilku interfejsach (Wi-Fi, Ethernet, VPN, maszyny wirtualne) wskaż adres interfejsu połączonego z telefonem. Bez prywatnego interfejsu aplikacja udostępnia pliki tylko na `127.0.0.1` i informuje o tym w terminalu.

## Pliki i katalogi

- „Wybierz pliki” obsługuje wiele plików dowolnego typu: zdjęcia, wideo, archiwa, dokumenty, pliki binarne i bez rozszerzenia.
- „Wybierz folder” przesyła wszystkie dostępne pliki wraz z nazwą wybranego folderu i strukturą podkatalogów. Celem jest aktualnie otwarty katalog w panelu. Puste foldery nie są przesyłane.
- Wybór folderu na telefonie zależy od przeglądarki i systemowego selektora plików. Gdy selektor nie pozwala wybrać folderu, użyj wielokrotnego wyboru plików lub prześlij folder jako ZIP. ZIP pozostaje zwykłym plikiem, aplikacja go nie rozpakowuje.
- Na komputerze można przeciągać pliki i foldery na pole wgrywania, jeśli przeglądarka udostępnia API odczytu katalogów.
- Kliknij folder, aby wejść do środka; okruszki nad listą pozwalają wrócić. Wyszukiwanie działa w aktualnym katalogu. „Odśwież” wczytuje pliki dodane bezpośrednio na komputerze.
- Ikona pobierania zapisuje pojedynczy plik. Pobieranie całego folderu jako ZIP nie jest implementowane.
- Transfery są strumieniowe: plik 1 GB nie jest w całości buforowany w RAM. Pobieranie obsługuje `HEAD` i pojedynczy zakres `Range`. Pliki większe niż limit są widoczne, ale nie można ich pobrać.
- Istniejące pliki nie są nadpisywane: powstaje np. `zdjęcie (1).jpg`. Przerwany upload nie publikuje niedokończonego pliku.
- Dla przenośności pomiędzy systemami odrzucane są nazwy niedozwolone na Windows, nazwy z końcową kropką/spacją oraz nazwy komponentów przekraczające 255 bajtów. Typ i zawartość pliku nie są filtrowane. System operacyjny może nakładać dodatkowe ograniczenia długości całej ścieżki.

## HTTPS i sieć lokalna

Certyfikat samopodpisany jest generowany automatycznie przez bibliotekę `selfsigned`, z SHA-256 i SAN obejmującym lokalny adres IP oraz localhost. Jest ponownie używany, a po zmianie adresu lub przed wygaśnięciem odnawiany. **Przeglądarka telefonu wyświetli ostrzeżenie o niezaufanym certyfikacie** — trzeba zaakceptować połączenie w jej ustawieniach/ekranie ostrzeżenia. Niektóre zarządzane urządzenia zabraniają takich wyjątków; dostępny jest również HTTP. HTTP nie szyfruje przesyłanych danych.

Serwery nasłuchują na wybranym prywatnym adresie LAN i na `127.0.0.1`, bez nasłuchiwania na adresach publicznych ani `0.0.0.0`. Akceptują klientów z podsieci wybranego interfejsu i z loopback. Aplikacja nie tworzy tuneli, nie otwiera portów na routerze i ignoruje `X-Forwarded-For`. Nie wystawiaj jej przez reverse proxy, przekierowanie portów lub tunel; infrastruktura pośrednicząca może ukrywać rzeczywisty adres klienta.

Gdy telefon nie łączy się:

1. Sprawdź wspólną sieć i właściwy adres `--host`.
2. Zezwól Node.js na ruch przychodzący w **prywatnej sieci** w zaporze Windows/macOS/Linux na wybranych portach.
3. Wyłącz izolację klientów Wi-Fi / użyj zwykłej sieci zamiast sieci gościnnej.
4. Sprawdź, czy VPN nie zmienia routingu, i zaakceptuj certyfikat przy HTTPS.

Link QR zawiera sekret sesji we fragmencie URL. Interfejs wymienia go na ciasteczko `HttpOnly`, `SameSite=Strict` (`Secure` przy HTTPS), po czym usuwa fragment z paska adresu. Udostępniaj link osobom, którym chcesz umożliwić pobieranie i wgrywanie; użytkownicy jednej sesji mają dostęp do całego udostępnionego drzewa. Nie ma usuwania plików przez interfejs.

Dowiązania symboliczne są pomijane, ścieżki są walidowane, a pliki pobierane jako załączniki `application/octet-stream`. Nie uruchamiaj aplikacji jako administrator i udostępniaj katalog, którego lokalni użytkownicy nie modyfikują w sposób wrogi równolegle do transferów. Twarde zakończenie procesu (np. `SIGKILL`, utrata zasilania) uniemożliwia sprzątanie: po takim zdarzeniu można ręcznie usunąć ukryte foldery `.localhost-share-tmp-*` po upewnieniu się, że żaden serwer z nich nie korzysta. Są zawsze ukryte dla klientów.

## Budowanie i testy

```sh
npm ci
npm run build
npm test
npm run test:large
```

`npm test` sprawdza uwierzytelnianie, rzeczywiste HTTP/HTTPS, pliki binarne, Unicode, podkatalogi, powtarzające się nazwy, Range/HEAD, limit, przerwane uploady, dowiązania, walidację sieci/Host/Origin i zamykanie portów. `npm run test:large` wykonuje rzeczywisty upload i download 1 GB, porównuje SHA-256, następnie sprawdza upload bez `Content-Length` przekraczający limit o jeden bajt. Potrzebuje około 1 GB wolnego miejsca i usuwa dane testowe.

Wynik budowania to `dist/`: kod serwera Node.js i zminimalizowany interfejs. Jest to aplikacja JavaScript uruchamiana przez Node.js, **nie samodzielny plik EXE**. Projekt można skopiować i uruchomić na Windows, macOS i Linux z obsługiwanym Node.js; zależności instaluj na docelowym systemie, ponieważ narzędzie budujące esbuild ma komponent właściwy dla platformy. Nie kopiuj `node_modules` pomiędzy systemami.

Zależności są przypięte do stabilnych wersji sprawdzonych w rejestrze npm przy tworzeniu projektu: `qrcode 1.5.4`, `selfsigned 5.5.0`, `ipaddr.js 2.5.0`, `esbuild 0.28.2`. Aktualizuj świadomie wraz z plikiem blokady i testami, zamiast zmieniać wersje automatycznie przy każdym uruchomieniu.

Dokumentacja źródłowa: [Node.js — cykl wydań](https://github.com/nodejs/Release), [selfsigned](https://github.com/jfromaniello/selfsigned), [node-qrcode](https://github.com/soldair/node-qrcode), [wybór folderów w przeglądarce](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/webkitdirectory).
