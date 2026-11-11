# Codebase Starmap

Enter a GitHub username and fly through their repositories as a 3D constellation.

- **Constellation:** every public repo is a star. Colour is its main language, size is its size, brightness is how recently it was pushed, and the halo grows with stargazers. The oldest repos sit near the core, so the galaxy grows outward over time and never reshuffles.
- **Star system:** fly into a repo and its top-level folders orbit as planets, its files as moons, and root files form a belt around the star.
- **Flares:** a year of weekly commit activity drives the star's surface. Scrub or play the timeline.
- **Trade lanes:** pick a planet and scan its imports (TypeScript/JavaScript, Python, Rust, Go) to draw routes to the folders it depends on.

Live at **[chasestruse.github.io/starmap](https://chasestruse.github.io/starmap/)**. Part of the Solar Forge projects.

## How it works

Everything runs in the browser. There is no backend.

| Data | Source | Cost |
|---|---|---|
| User + repos | `GET /users/:login`, `GET /users/:login/repos` | 2 requests |
| Planets + moons | `GET /repos/:o/:r/git/trees/:branch?recursive=1` | 1 request |
| Flares | `GET /repos/:o/:r/stats/commit_activity` | 1 request (up to 3 while GitHub computes) |
| Trade lanes | `raw.githubusercontent.com` | outside the REST quota |

GitHub allows 60 unauthenticated requests per hour per IP. Responses are cached in IndexedDB for an hour, and visitors can add a fine-grained token (stored only in their browser) to raise the limit to 5,000.

The architecture diagram is in [docs/codebase-starmap.sforge.json](docs/codebase-starmap.sforge.json) (open it with Solar Forge Diagrams).

## Development

Requires Node 22+.

```sh
npm install
npm run dev      # http://localhost:5173/starmap/
npm run check    # type check, tests, production build
```

Stack: Vite, TypeScript, Three.js (no framework). UI panels are plain TypeScript and HTML.

```
src/github/   REST client (cache, ETags, rate limit), IndexedDB cache, API types
src/galaxy/   pure functions: API data → stars, planets, moons, import lanes
src/scene/    Three.js stage (camera, bloom, picking, labels) and the two views
src/ui/       DOM helpers
src/app.ts    controller: navigation, panels, timeline
```

## Deploying

The site serves the built files from the `starmap/` folder of the `chasestruse.github.io` repo:

```sh
scripts/copy-to-site.sh            # builds, then copies dist/ into ../chasestruse.github.io/starmap
```

Then commit that on a branch in the site repo and open a PR.

## License

MIT
