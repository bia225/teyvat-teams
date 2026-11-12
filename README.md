# Genshin Team Finder

A simple tool to help people build Genshin Impact teams. Mark the characters you own (or import them from screenshots), pick one, and see the best teams you can build for them right now.

**Live site:** https://bia225.github.io/teyvat-teams/

## Features

- **Roster with constellations**, saved in your browser.
- **Screenshot import.** Upload or paste screenshots of your HoYoLAB character list. Names and constellations (the number in each portrait's corner) are read in your browser with Tesseract.js; nothing is uploaded.
- **Best team per guide archetype**, filled with the best characters you own, with swap options for each slot and teams that need a specific constellation only shown when you have it.
- **"One character away"** teams that show what you're missing.
- **Keeps itself up to date** (see below).

## How the data stays current

A GitHub Actions workflow ([`update-data.yml`](.github/workflows/update-data.yml)) runs every day:

1. **Characters**: new playable characters are read from the Genshin Impact Fandom wiki and added once their release date has passed. Existing entries are never changed or removed.
2. **Teams**: every guide the site uses is checked. When a guide's Teams section changes, Claude extracts the new teams, they're checked against the character list and the data rules, and only then replace that guide's teams. Characters without a guide are checked for a newly published one a few at a time.
3. Everything is validated and tested before it's committed. The site redeploys on its own.

If anything needs a human (a page layout changed, an extraction failed its checks), the workflow opens a GitHub issue instead of publishing bad data.

### Turning on automatic team updates

Character updates work out of the box. Team updates need an Anthropic API key:

1. Create a key at https://console.anthropic.com/.
2. In this repo, go to **Settings → Secrets and variables → Actions → New repository secret**.
3. Name it `ANTHROPIC_API_KEY` and paste the key.

Without the key, guide changes are reported in an issue and picked up automatically as soon as the key is added. Each guide extraction is one API call. Optionally set a repository variable `ANTHROPIC_MODEL` to choose the model.

You can run the update by hand from **Actions → Update game data → Run workflow**.

## Project structure

```
index.html               page markup
assets/styles.css        styles (light and dark themes)
src/                     browser code (ES modules, no build step)
  app.js                 page wiring and rendering
  db.js                  loads data/*.json
  teams.js               team matching
  reader.js              screenshot reading: card detection, constellation badges, name matching
  ocr.js                 in-browser text recognition (Tesseract.js)
  claude.js              Claude features, only active when the page runs on claude.ai
data/
  characters.json        playable characters
  teams.json             guides and their teams
  meta.json              last-updated dates and update bookkeeping
scripts/                 updaters and data validation (Node 20+, no dependencies)
tests/                   node:test suites
```

Team slots list options in the guide's order of preference. `"fischl@6"` means the option needs C6.

## Development

```sh
npm run serve      # http://localhost:8000
npm test           # all tests
npm run validate   # check the data files
npm run update     # run the updaters locally (set ANTHROPIC_API_KEY to update teams)
```

## Credits

Team data is taken from [KeqingMains](https://keqingmains.com/) quick guides, used with permission; each team links to its guide. Character data comes from the [Genshin Impact Fandom wiki](https://genshin-impact.fandom.com/). Fan-made and not affiliated with HoYoverse. Genshin Impact is a trademark of HoYoverse.
