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
* **The menu:** tap the middle of the page. It has:
  * the **Read / Edit** switch
  * a **Pages / Scroll** switch
  * Contents, Files and Search
  * a page slider and sync status
* **Display settings (Aa):**
  * Ten fonts and twelve text sizes, with boldness.
  * Line spacing, margins, and left or justified alignment.
  * Pages or continuous scroll, and slide or instant page turns.
  * White, Cream, Green, Dark and Black themes.
* **Two columns:** on a computer or a tablet held sideways, pages show as a two-page spread. Set this under **Aa → Layout → Columns**: Auto, One or Two.
* **Page-turner remotes:** Bluetooth remotes that send arrow keys, Page Up/Down or Space turn pages. Phone browsers don't let web apps use the volume buttons.
* **Progress:** tap the bottom line to switch between page number, time left, percentage or nothing.
* **Contents:** lists the note's headings and your highlights, each with its page.
* **Where you left off:** Flint always opens on the Library. **Continue reading** there reopens your last note at the same page, and Flint remembers your place in every note.

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

After following a link, a **Back to …** button returns you to the page you were on. It steps aside after two page turns or a little scrolling; Android's Back gesture always works.

## Tags

**Tags** on the Library lists every tag in your vault with a count. It includes both `#tags` in the text and tags in a note's properties. A filter box helps with long lists.

Tap a tag to see its notes. Parent tags include nested ones, so `#study` also shows `#study/greek`. Tapping a tag inside a note goes to the same page.

Android's Back goes from a note to the tag's notes, then to the tag list, then to the Library. On iPhone, use the Back to … button and the arrow at the top.

Footnote and bookmark anchors from documents converted from Word (such as `#_ftn17`, `#_edn2` or `#_Toc123`) aren't treated as tags. Neither is anything after a `#` inside a link or web address.

To hide other tags, open the tag and tap **Hide this tag**. You can also edit the list under **Settings → Reading → Hidden tags**, where a name ending in `*` hides every tag that starts that way.

## Folders and pins

Search finds folders as well as notes. Tapping a folder opens a popup with its subfolders and notes. Opening a note from there and pressing Back brings the popup back.

**Pinned** on the Library has two sections, pinned folders and pinned notes.
* **Pin a folder:** tap the pin in its popup.
* **Pin a note:** tap the middle of the page, then the pin at the top.

Pins are stored in Flint only (and sync between your phones). They never change your vault or Obsidian.

## Renaming notes

In Edit, tap the title and type a new name. If other notes link to it, Flint updates those links too, just like Obsidian does. It asks you first and says how many links will change. Renaming needs an internet connection.

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
* **New notes:** tapping New shows every folder in your vault so you can choose where the note goes, then asks for its name.
* **Fonts** are bundled under the SIL Open Font License (see `fonts/LICENSES-OFL.txt`).

## Notebook, notes and review

* **Notebook** (on the Library) lists every highlight in your vault, grouped by note, with search and a **With notes** filter. Tap one to open the note right at that highlight.
* **Notes on highlights:** tap a highlight while reading and choose **Add note**. Or select text and tap **Note** to highlight and add a note in one step. Highlights with a note get a dotted underline.
* **From your highlights** on the Library resurfaces one highlight a day. Tap **Another** for a different one.
* **Notebook views:** **All** shows every highlight. **By note** gives each note its own notebook, which you can also open from **⋯ → Highlights in this note**. **My notebooks** holds notebooks you make yourself.
* **Your own notebooks:** tap **+** beside any highlight in the Notebook, or tap a highlight while reading and choose **Notebook**, then tick the notebooks it belongs in. A notebook can hold highlights from any number of notes. You can rename and delete them; deleting a notebook never removes highlights from your notes.
* Tapping a highlight anywhere (the Notebook, your notebooks, or the Library card) opens the note at that exact spot, even if images are still loading.

Notes on highlights are stored in Flint, not in your Markdown files, so your Obsidian notes stay exactly as they are. The highlights themselves are normal Obsidian `==highlights==` in the note.

## Up next, bookmarks and stats

* **Up next:** add a note from **⋯ → Add to Up next**. The Up next tile shows your queue with progress and minutes left. When you read a queued note to the end, it moves to **Finished**.
* **Bookmarks:** use **⋯ → Bookmark this page**. A small ribbon marks bookmarked pages, and **Contents → Bookmarks** lists them.
* **Reading stats:** Flint counts time spent actively reading. The line under your vault name shows today's time and your streak. Tap it for the week at a glance.

## Listen and Define

* **Listen** (in the reader menu) reads the note aloud from the page you're on, highlighting each sentence and turning pages as it goes. Use the small player to pause, skip back or forward a sentence, or change speed. It keeps the screen on while listening, so Android doesn't stop it. Choose a voice under **Settings → Listening**; voices come from your phone.
* **Define:** press and hold a single word, then tap **Define**. This needs an internet connection and covers English words.

## Night theme

**Aa → Themes → Night theme** switches to Cream, Dark or Black between the times you choose, and back again in the morning.

## Sync between phones

Flint keeps its own data in one small file in your OneDrive, at `Apps/Flint/flint-data.json`, outside your vault. That covers notebook notes, pins, Up next, bookmarks, reading positions and reading stats. Every phone with Flint signed in to the same OneDrive stays in step, and Obsidian never sees the file.

Changes made on different phones merge item by item, so nothing is lost if you use two phones offline. Turn this off under **Settings → Sync between phones** if you'd rather keep each phone separate.

## Print and export

Tap the middle of a page, then **⋯** at the top. In Edit, **⋯** is in the top bar. The menu has:

* **Print.** Choose paper (Letter, A4, Legal, A5), orientation, margins, typeface, text size and line spacing. You can also include or leave out the title, the source line, highlight color and images. Your phone's print screen opens next.
* **Export as PDF.** This uses the same page settings. On the next screen, choose **Save as PDF** as the printer, which gives a real text PDF rather than a picture.
* **Export as Word.** Makes a .docx with headings, lists, tables, links, highlights and images, using the same paper and margins.
* **Export as Markdown.** Saves the note file exactly as it is in your vault.

Exported files go to your Downloads folder. Switch **Exported files** to **Share** to send them straight to another app instead. Print settings are remembered for next time.

## Copy with citation

Select text in a note and tap **Cite**. Flint finds where a clipped note came from using its properties: `source`/`url`, `title`, `author`, `published`, and the clip date. This works with the Obsidian Web Clipper and most other clippers.

* **Styles:** MLA, APA, Chicago, Turabian, Harvard or IEEE.
* **Use as:** **Bibliography** for a works-cited, reference or bibliography entry, or **Footnote / In-text** for a footnote (Chicago and Turabian) or an in-text citation (the others).
* **What's copied:** the excerpt in quotation marks with its citation, formatted with italics where the style needs them. You can turn the excerpt off to copy just the citation.

**Copy citation** in the ⋯ menu copies a citation for the whole note.

For personal notes with no web source, the button simply says **Copy** and copies the text.

Check citations before submitting. Flint can only use the details the clipper saved; a missing author or date is left out, as each style's rules allow.

## Built to last

Flint is designed to keep working for years without maintenance:

* **No outside dependencies at run time.** Every library and font is bundled with the app. It doesn't depend on any other website or service staying online besides your own GitHub Pages and Microsoft OneDrive.
* **It never changes by itself.** Flint only updates when you upload new files to GitHub. Phone updates, browser updates and Obsidian updates can't swap out its code.
* **Standard, stable building blocks.** It uses ordinary web features that browsers keep supporting, plus Microsoft's stable OneDrive API (v1.0).
* **Your notes stay plain Markdown files in OneDrive**, the same files Obsidian reads. Flint adds no files to your vault; its own data lives in `Apps/Flint`.
* **No expiring keys.** The Microsoft app registration has no secret, so there's nothing that expires and has to be renewed.
* **Backup of Flint-only data.** Settings → Backup saves your pins, reading positions and display settings to a file you can restore later or on another phone.
* **Offline copy protection.** Settings → Offline copy shows whether Android has marked Flint's storage as protected from automatic clearing. Installing Flint to the home screen usually turns this on.

The realistic long-term risks are on Microsoft's side, such as changes to sign-in rules or the OneDrive API. If that ever happens, the notes themselves are untouched in OneDrive and Obsidian keeps working.

## Updating the app

Upload the changed files to the same GitHub repository. If you change any file, also change the `VERSION` value at the top of `sw.js` so phones fetch the new version. It applies the next time the app is opened twice.

## Trying it on a computer first

Run `python3 -m http.server 8000` in this folder and open `http://localhost:8000/`. Add `http://localhost:8000/` as a second SPA redirect URI in your app registration.
