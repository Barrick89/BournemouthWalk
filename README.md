# Bournemouth Walk

**Ein Spaziergang an der Promenade von Bournemouth Pier nach Boscombe Pier – direkt im Browser.**

Sandstrand, bunte Strandhütten, hölzerne Buhnen, Kiefern auf den Klippen, Möwen über dem Wasser und die Brandung,
die den Sand hinaufläuft. Alles entsteht aus Code: keine Bilder, keine 3D-Modelle, keine Sounddateien.
Die ganze Küste passt in **eine einzige HTML-Datei von rund 60 kB**.

Inspiriert von [Abyssal Garden](https://github.com/Noniv/abyssal-garden): gleiche Bauweise (reines WebGPU, keine Engine,
alles prozedural, gebündelt in eine `index.html`), aber an Land – an der Südküste Englands.

## Ausprobieren

1. [`index.html`](index.html) herunterladen.
2. In **Chrome** oder **Edge** auf einem Desktop-Rechner öffnen.
3. Ein paar Sekunden warten, bis die Bucht aufgebaut ist, dann **Losgehen** drücken.

Nichts zu installieren, funktioniert offline. Benötigt einen Browser mit **WebGPU**.

## Was es unterwegs zu sehen gibt

Der Weg ist rund **1,6 km** lang und folgt der Promenade (Undercliff Drive) nach Osten:

- **Bournemouth Pier** mit Eingangsgebäude, Laternen und Pavillon am Kopf – Startpunkt
- **East Cliff** mit der Villa des Russell-Cotes-Museums oben auf der Klippe
- **East Cliff Lift**, die Standseilbahn die Klippe hinauf
- Hunderte **Strandhütten** mit bunten Türen, Kioske, Bänke, Laternen, ein roter Radweg
- **Buhnen** (Groynes) aus Holz alle ~100 m, auf denen man balancieren kann
- Sonnenschirme, Windschutze, Handtücher, Sonnenbadende, Rettungsschwimmer-Stationen mit rot-gelben Flaggen
- Spaziergänger auf der Promenade und am Wasser, kreisende Möwen, Segelboote in der Bucht
- **Overstrand** mit Strandhütten auf drei Etagen
- **Boscombe Pier** mit dem langen, flachen Eingangsgebäude und dem schrägen Vordach – das Ziel
- In der Ferne: **Old Harry Rocks** und die Purbeck Hills im Südwesten, die **Isle of Wight** mit den Needles im Südosten, Hengistbury Head im Osten
- Drei Tageszeiten: **Morgen**, **Mittag** und **Abend** mit Sonnenuntergang über Purbeck, leuchtenden Laternen und Fenstern
- Eine Geräuschkulisse, die live entsteht: Brandung im Rhythmus der sichtbaren Wellen, Wind, Möwenrufe und Schritte, die auf Sand, Beton, Holz und Gras unterschiedlich klingen

Unten zeigt eine Leiste, wie weit es noch bis Boscombe Pier ist. Wer ankommt, bekommt Zeit und Strecke angezeigt.

## Steuerung

| | Tastatur & Maus |
|---|---|
| Umsehen | Maus bewegen |
| Gehen | `W` `A` `S` `D` oder Pfeiltasten |
| Laufen | `Shift` halten |
| Springen | `Leertaste` |
| Tageszeit wechseln | `T` |
| Aussichtspunkte | `1` bis `5` (Start, Bournemouth-Pier-Kopf, East Cliff Lift, Strand, Boscombe Pier) |
| Ton an / aus | `M` |
| Leistungsanzeige | `H` |
| Menü | `Esc` |

Promenade, Strand, Piers und Buhnen sind begehbar; Hütten, Gebäude, Laternen und Geländer sind fest. Die steilen
Klippen kommt man nicht hinauf, in den Chines (Tälern) bei den Piers schon. Schwimmen geht nicht – bis zu den Knien
ins Wasser aber schon.

**Auf dem Touchscreen:** einen Finger halten zum Gehen und wischen zum Umsehen, ein zweiter Finger zum Laufen.

## Detailstufen

**Niedrig**, **Mittel** und **Hoch** im Menü (lädt die Seite neu). Niedrigere Stufen zeigen weniger Bäume, Büsche und
Menschen, nutzen eine kleinere Schattenkarte, verzichten (Niedrig) auf Kantenglättung und starten mit geringerer
Auflösung. Läuft es zu langsam, senkt das Spiel die Auflösung automatisch.

## Wie es funktioniert

- Gelände (Meeresboden, Strand, Promenade, Klippen, Chines) ist eine Höhenfunktion, die als Gitter von ~250 000 Punkten
  aufgebaut und entlang der Kurve der Poole Bay gebogen wird.
- Hütten, Piers, Gebäude, Buhnen und Strandleben werden aus Quadern, Zylindern und Dächern zusammengesetzt;
  Kiefern, Büsche, Menschen, Möwen und Boote sind instanziert und werden im Vertex-Shader animiert – ohne
  CPU-Arbeit pro Bild.
- Das Meer ist ein polares Gitter um die Kamera mit Wellen, Brandungsschaum und Spülsaum, der den Sand hinauf- und
  wieder hinabläuft.
- Gezeichnet wird direkt mit **WebGPU** (Schattenkarte, 4× MSAA, HDR, ACES-Tonemapping). Keine Engine, keine 3D-Bibliothek.
- Der Ton wird live mit der Web Audio API erzeugt.

## Selbst anpassen

Der lesbare Quellcode liegt im Ordner [`source`](source). Zum Neubauen von `index.html` wird
[Node.js](https://nodejs.org) 18 oder neuer benötigt:

```bash
cd source
npm install
npm run build            # minifiziert
npm run build:readable   # unminifiziert, zum Debuggen
```

| Datei | Inhalt |
|---|---|
| [`source/src/world.js`](source/src/world.js) | Die Küste: Geländeprofil, Piers, Strandhütten, Buhnen, Lift, Gebäude, Strandleben, Pflanzen, Kollision, Orte. **Guter Einstieg.** |
| [`source/src/shaders.js`](source/src/shaders.js) | Das Aussehen: Himmel und Wolken, Sand, Promenade, Klippen, Materialien, Meer, Tonemapping (WGSL) |
| [`source/src/main.js`](source/src/main.js) | Renderer, Kamera, Gehen und Kollision, Tageszeiten, HUD, Menü |
| [`source/src/audio.js`](source/src/audio.js) | Die Geräuschkulisse |
| [`source/src/quality.js`](source/src/quality.js) | Die Detailstufen |
| [`source/src/math.js`](source/src/math.js) | Zufall, Rauschen und der Mesh-Baukasten |
| [`source/template.html`](source/template.html) | Die Seite drumherum: Ladebalken, Menü, Fortschrittsleiste |

Ein paar einfache Ideen:

- **Tageszeiten:** die Tabelle `TOD` in `main.js` (Sonnenrichtung, Farben, Dunst, Belichtung)
- **Gehgeschwindigkeit:** `6.5 : 2.7` in `main.js` (Laufen : Gehen, in m/s)
- **Türfarben der Strandhütten:** `HUTDOOR` in `world.js`
- **Wellen:** `waves()` und `swash()` in `shaders.js`

## Lizenz

[MIT](LICENSE)
