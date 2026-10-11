# Flint

A Kindle-style reader for your Obsidian vault in OneDrive, with editing when you need it and a full offline copy on your phone.

Setup takes about 15 minutes and costs nothing. You do it once.

## 1. Put the app online (GitHub Pages)

The app is just these files. It needs an `https://` address so Microsoft sign-in works.

1. Create a free account at github.com if you don't have one.
2. Create a new **public** repository called `flint`.
3. Choose **uploading an existing file**, then drag in everything from this folder, keeping the `js`, `vendor` and `icons` folders intact. Commit.
4. In the repository, open **Settings → Pages**. Under *Build and deployment*, pick **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
5. After a minute your app lives at `https://YOUR-USERNAME.github.io/flint/`. Write that address down exactly, including the final `/`.

Nothing private is stored in these files. Your notes and sign-in stay on your phone and in your OneDrive.

## 2. Register the app with Microsoft

This gives the app permission to ask you to sign in to your OneDrive.

1. Go to **portal.azure.com** and sign in with the same personal Microsoft account that holds your vault. If it says you need a directory or subscription, sign up for the free Azure account first. App registrations don't cost anything.
2. Search for **App registrations** and choose **New registration**.
3. Fill it in:
   * **Name:** Flint
   * **Supported account types:** *Personal Microsoft accounts only*
   * **Redirect URI:** choose **Single-page application (SPA)** and paste your address from step 1, for example `https://your-username.github.io/flint/`
4. Select **Register**.
5. Copy the **Application (client) ID** from the overview page. It looks like `1a2b3c4d-....`

The platform must be **Single-page application**, not "Web", and the address must match exactly, including the trailing slash.

## 3. Connect on your phone

1. Open your app address in Safari (iPhone) or Chrome (Android).
2. Add it to your home screen:
   * **iPhone:** Share button → **Add to Home Screen**
   * **Android:** ⋮ menu → **Install app** or **Add to Home screen**
3. Open it **from the home screen icon** and do the rest there. On iPhone, the home screen app keeps its own storage separate from Safari.
4. Paste the app ID, sign in, open your vault folder, and tap **Use this folder**.
5. Keep the app open while it saves your notes for offline use. The home screen shows progress.

## Reading

Notes open in **Read** mode, which works like a Kindle:

* **Turning pages:** tap the right edge or swipe left for the next page, and tap the left edge or swipe right to go back.
* **The menu:** tap the middle of the page. It has the **Read / Edit** switch, Contents, Files, Search, a page slider, and sync status.
* **Display settings (Aa):**
  * Ten fonts and twelve text sizes, with boldness.
  * Line spacing, margins, and left or justified alignment.
  * Pages or continuous scroll, and slide or instant page turns.
  * White, Cream, Green, Dark and Black themes.
* **Page-turner remotes:** Bluetooth remotes that send arrow keys, Page Up/Down or Space turn pages. Phone browsers don't let web apps use the volume buttons.
* **Progress:** tap the bottom line to switch between page number, time left, percentage or nothing.
* **Contents:** lists the note's headings and your highlights, each with its page.
* **Where you left off:** Flint reopens the last note at the same page and remembers your place in every note.

None of the display settings touch your files. They're stored on the phone only.

## Highlights

Press and hold on text, adjust the selection, then tap **Highlight**. Flint wraps that exact text in `==` in the note, which is how Obsidian marks highlights. To remove one, tap it and choose **Remove highlight**.

Highlights are the only thing Read mode ever writes to a note. Before saving, Flint:

* checks the selection matches exactly one place in the note;
* snaps it to whole words without cutting through links or formatting;
* confirms the result renders with only that one highlight added.

If any check fails, the note is left untouched and Flint tells you why. Checkboxes are display-only while reading.

## Links

All Obsidian link styles work when reading:
* `[[Note]]` and `[[Note|alias]]`
* `[[Note#Heading]]` and `[[Note#^block-id]]`
* `[[#Heading]]` within the same note
* `[[Folder/Note]]` and Markdown links like `[text](Folder/Note%20Name.md)`
* Embeds such as `![[Note]]`, `![[Note#Heading]]` and `![[image.png]]`

After following a link, a **Back to …** button returns you to the page you were on.

## Scripture and Logos

Bible references anywhere in your notes are linked while reading, for example "John 3:16", "1 Cor 13:4–7", "Ps. 23" or "Rom 8:28; 12:1-2". Tapping one opens Logos to that passage. The links exist only on screen. Your notes aren't changed.

The first time you tap one, Flint asks which Bible version Logos should open (ESV, NIV2011, NASB95, CSB, LEB and so on). You can change it under **Settings → Scripture**.

If Logos opens but doesn't jump to the verse, switch **Open references with** to **Ref.ly link**. That uses Logos's own web links, which hand off to the app.

## Offline

Every note, and every image your notes embed, is saved on the phone. When you open Flint it shows your vault immediately and syncs in the background. If OneDrive can't be reached, you keep reading and browsing the vault from the last sync, and any edits or highlights upload later.

## How it keeps your notes safe

* **Nothing is overwritten blindly.** Each save tells OneDrive which version it started from. If the file changed elsewhere in the meantime, OneDrive refuses the save.
* **Edits in two places are merged when they don't overlap.**
* **Overlapping edits wait for you.** Open the note in Edit to choose: keep both, use the vault version, or use the phone's version.
* **Files stay byte-for-byte the same apart from what you changed.** Windows line endings and byte-order marks are preserved. A note Flint can't round-trip exactly opens read-only.
* **Only `.md` notes are ever written.** Flint never renames, moves or deletes anything, and never touches your `.obsidian` folder, attachments or plugin data.

## Plugin HTML

**Settings → Reading** controls how HTML added by plugins appears when reading:
* Hide the tags and keep the text (default)
* Hide HTML blocks completely
* Show it formatted

Query code blocks such as Dataview are hidden while reading, and you can edit that list. Edit mode always shows the file exactly as it is.

## Good to know

* **Plugins don't run here.** They need the Obsidian app itself.
* **Rename, move and delete** in Obsidian on your computer.
* **Sign-in renewal:** Microsoft limits browser sign-ins to about a day. Flint renews it with a quick redirect when you open it, usually without a password. Reading never depends on it.
* **Today's note** creates `YYYY-MM-DD.md`. Set its folder under **Settings → New notes**.
* **Fonts** are bundled under the SIL Open Font License (see `fonts/LICENSES-OFL.txt`).

## Updating the app

Upload the changed files to the same GitHub repository. If you change any file, also change the `VERSION` value at the top of `sw.js` so phones fetch the new version. It applies the next time the app is opened twice.

## Trying it on a computer first

Run `python3 -m http.server 8000` in this folder and open `http://localhost:8000/`. Add `http://localhost:8000/` as a second SPA redirect URI in your app registration.
