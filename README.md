# H3S Web App

Browser control for the QCY H3S (and other QCY headsets) on Linux, using Web
Bluetooth. Protocol recovered from QCY 4.0.7. Protocols recovered from QCY 4.0.7 (`com.qcymall.qcylibrary`,
`com.jieli.jl_bt_rcsp`).

## Run

```sh
./run.sh
```

Serves this folder and launches Chromium with Web Bluetooth enabled
(`--enable-features=WebBluetooth`; Chromium on Linux keeps it off otherwise).
Or manually:

```sh
cd h3s-web-app
python3 -m http.server 8765
chromium --enable-features=WebBluetooth http://localhost:8765
```

## Test

```sh
npm test
```
