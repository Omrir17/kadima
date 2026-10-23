# קדימה (Kadima)

Israeli public-transport planner that also uses the rides people offer you along the way.

- **אוספים אותי**: someone will drive up to N minutes to pick you up. Finds the best stop to get off at.
- **מקפיצים אותי**: a short lift at the start. Finds the station that saves the most time.
- **אני בטרמפ**: you're in a car going somewhere else. Finds where to get out and how to continue.
- **אני באוטובוס**: you're on line X. Finds which stop to get off at for the best way onward.

## How it works
- Routing runs **on the phone** (RAPTOR algorithm in a Web Worker) on compact daily timetables built from the Ministry of Transport GTFS feed. There's no server to pay for.
- Live bus positions and delays come from Hasadna's Open Bus Stride API.
- Driving times come from the public OSRM server, scaled by an Israeli rush-hour factor (you can calibrate with the time Waze shows).
- Maps are OpenFreeMap. Address search is Photon (OSM).
- Hosted free on GitHub Pages. A nightly GitHub Action downloads the new GTFS, rebuilds the data, and redeploys.

## Local development
```
npm install
# download & unzip GTFS into .gtfs/ (see .github/workflows/deploy.yml), then:
npm run data     # builds public/data
npm run dev
```
Testing aids: `?at=32.07,34.79` fakes your GPS position, `?now=2026-10-25T09:00:00%2B02:00` fakes the clock.
