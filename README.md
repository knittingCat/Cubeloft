# Cubeloft

Build block dioramas in your browser. Place blocks, add people and signs, switch between day, sunset and night, then save a picture or share a link so others can look around your scene.

Made for school projects like "illustrate your favourite scene from a story": build the scene, post the picture or link on the class forum, and look at classmates' dioramas in a class gallery.

Live site: https://cubeloft.onrender.com

## What you can do

**Build**
- 35 blocks with pixel-art textures: grass, dirt, stone, cobblestone, sand, snow, ice, water, lava, wood, bricks, glass, glowstone, gold, obsidian, coloured wool and rainbow-coloured planks (red to violet) beside the natural planks.
- Stage size: Small, Medium or Large, or Custom with your own width and depth in blocks (12 to 96, or keep it square).
- Tools: Build, Erase, Box (fill an area), Select, Pick (copy a block's type), Sign (floating text), Person, Door (1 wide, 2 tall, in any planks colour; click to open and close), Animate (people walk, doors swing, then play it back; saved with the diorama). People can sit on the floor or on a block with their legs hanging down.
- Copy and paste whole structures, with rotate and mirror. Build symmetrically across the left-right or front-back middle line.
- Undo and redo for everything, including Clear, which removes only what you added and leaves the scene you started with.
- Water and lava flow: sources fall through empty space and spread across surfaces, seeking nearby drops, and drain away when the source is removed. Flowing lava that meets water cools to cobblestone. The flow is worked out from the source blocks, so only the sources are saved.
- Water and lava sources with nothing under them fall until they rest on something.

**People**
- Add a person, then change their skin, hair, hat, top, bottoms, shoes and name.
- Pose them standing or lying down, turn the whole person and the head separately, and move them.
- Fly mode (only on devices with a keyboard; eye button or F): up/down arrows fly forward/back, left/right turn, Shift + left/right slide sideways, Shift + up/down rise and sink, dragging looks around. All tools and shortcuts keep working, so you can build while flying; Esc or F stops.
- Look through their eyes: arrows walk, Shift + left/right spins around, Shift + up lies face down (or gets up), Shift + down lies on the back (or gets up), dragging turns the head, the Head straight button matches the head to the body, Esc finishes. The person ends up wherever you left them.

**Share**
- Picture: a PNG with an optional title and caption bar.
- Copy link: only on your own diorama cards in My dioramas (no toolbar button, not on other people's cards). It copies a short link (`/#d=<id>`) that anyone can open without signing in; only everyone-gallery dioramas without a code have one.
- Save a diorama to your account. It also autosaves in the browser.
- Anyone opening someone else's diorama sees it view-only, with a Report button.

**Accounts and the class gallery** (when the site runs with its server)
- Sign in with a username and password. No email and no real name.
- Save dioramas to your account as private or published to the gallery, optionally with a code to open a single diorama, or a code for your whole gallery.
- Class galleries: a teacher (anyone signed in) starts a class in the Gallery and gets a 6-character class code. Students type the code under Join a class. When saving, a diorama can be shared with one of your classes: only that class (and its teacher) can open it, it never appears in the everyone gallery or in a public link. The teacher can take a diorama down, remove people, hand the class to another member, or delete the class; shared dioramas then go back to private and their authors keep them. Reports on a class diorama go to the teacher.
- Feedback: in the Gallery, signed-in people can send a feature request or an error report (up to 10 an hour). Admins read them through `GET /api/feedback` and close one with `POST /api/feedback/:id/done`; there is no page for it in the app.
- Reports: anyone can report a gallery diorama, signed in or not (people who are not signed in are limited to a few reports an hour, and one address can report a diorama once; only a hash of the address is kept). Admins always see a Reports button, and anyone picked to review a report sees it while one is waiting. A white number in a red circle on the button's top left corner shows how many are waiting, and can open the diorama, dismiss the report, hide the diorama from the gallery, or delete it. A report about an admin's diorama goes to a different admin, or to another member if there is no other admin. Nobody reviews a report they wrote or one about their own diorama. Reports nobody can be picked for stay open for the developer.

## Controls

| Action | How |
| --- | --- |
| Look around | Drag to rotate, scroll or pinch to zoom, right-drag or two fingers to move |
| Place a block | Pick one at the bottom, click the ground or a block. `P` places at the pointer |
| Remove a block | Right-click, or Shift+click, or the Erase tool |
| Tools | `B` build, `E` erase, `X` box, `S` select, `I` pick, `T` sign, `H` person |
| Blocks | `1` to `9` pick the first nine blocks |
| Copy and paste | Select an area (it copies), then `V` to paste, `Q` rotate |
| Mirror | `M`, choose an area, then click where the mirror line goes |
| Symmetry | `Y` cycles off, left-right, front-back, both |
| Undo and redo | Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z |

## Run it

```bash
npm install
# .env (never commit it) holds the Neon pooled connection string:
#   DATABASE_URL_POOLED="postgresql://...-pooler...neon.tech/neondb?sslmode=require"
npm start            # http://localhost:3000
```

Tables are created automatically on start.

To preview just the editor without the account server, run `python3 -m http.server 8000` and open http://localhost:8000. The account, gallery and report buttons stay hidden. Opening `index.html` straight from disk does not work, because browsers block ES modules on `file://`.

## Deploy

The repo includes a Render blueprint (`render.yaml`). Connect the repo on Render and add `DATABASE_URL_POOLED` as a secret environment variable. The server only touches the database when someone signs in or uses accounts, so a Neon database can scale to zero when nobody is around.

## Tests

```bash
npm test
```

Runs the world logic tests and the account server tests. The server tests use throw-away `zz_test_` tables in the database from `.env` and drop them afterwards.

## Project layout

| Path | What it is |
| --- | --- |
| `src/world.js` | The voxel grid, undo history, ray casting, flowing liquid, people, and the save format (no DOM) |
| `src/blocks.js`, `src/textures.js` | The block list and the pixel-art textures drawn with canvas |
| `src/view.js` | The Three.js scene: lights, shadows, stand, signs, people, flowing liquid, camera |
| `src/main.js` | Tools, palette, dialogs, picture export, sharing |
| `src/clipboard.js` | Copy, paste, rotate, mirror and symmetry helpers |
| `src/account.js`, `src/api.js` | Sign in, saving online, gallery, codes and reports (browser side) |
| `server/` | Express server: accounts, sessions, saved dioramas, gallery, reports (Postgres on Neon) |
| `test/` | World and server tests, plus a demo scene for screenshots |
| `vendor/` | Three.js r186 and OrbitControls (MIT licence), vendored so the site works offline |

## Maintaining the live site

Admin tasks are done in the Neon SQL editor:

```sql
-- make someone an admin (admins can open, hide and delete any diorama in the app)
UPDATE users SET is_admin = TRUE WHERE username = 'their_username';

-- see open reports
SELECT r.id, r.reason, r.created_at, d.id AS diorama_id, d.title, o.username AS owner, p.username AS reporter
FROM reports r
JOIN dioramas d ON d.id = r.diorama_id
JOIN users o ON o.id = d.owner_id
JOIN users p ON p.id = r.reporter_id
WHERE r.status = 'open'
ORDER BY r.created_at DESC;

-- remove a diorama (its reports go with it)
DELETE FROM dioramas WHERE id = 123;

-- remove a user and everything they made
DELETE FROM users WHERE username = 'someone';
```

There is no password reset, because accounts have no email. A forgotten password means deleting the account and signing up again.

## Licence

Three.js and OrbitControls in `vendor/` are MIT licensed. Add your own licence for the rest of the code before sharing it widely.
