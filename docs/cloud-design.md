# Accounts and the cloud copy: design

Approved by the owner on 2026-11-25 ("Yes, build it"), in the recoverable form: a forgotten password must never lose the data, so the cloud can open the copy. Nothing is end-to-end encrypted. The app says so.

## What it does

- Optional account: Google, or email and password. The app works the same without one.
- The phone stays the place of truth. After each change the whole notebook is packed, compressed and saved in the cloud, with older copies kept.
- A new phone: sign in, and the notebook comes back.
- Forgotten password: reset by email, or sign in with Google. A person can link both.

## What must never happen

| Danger | What prevents it |
|---|---|
| Another person reads or writes someone's copy | `firestore.rules`: only the owner's own path; everything else is refused |
| One phone silently overwrites what another saved | Each save names the revision it follows. A save that does not follow the current one is refused by the app's transaction **and** by the rules |
| Entries made on two phones are lost | Both are compared with their last common copy (three-way). Only a combination without conflict that passes every ledger check is applied by itself. Otherwise the person chooses, and the copy not chosen is kept (pinned) |
| Right on each phone, wrong together | Checked after combining: an entry for a person merged elsewhere, a correction, advance, schedule or invoice of a debt cancelled or replaced elsewhere, two schedules for one debt: never combined. The same receipt or invoice number, an imported line twice, a period of a plan ended elsewhere, a debt of a person archived elsewhere: asked, and both can be kept. What was already so on one phone does not count |
| A choice made for one situation is applied to another | The choice carries the situation it was shown for (reason and copy); anything else asks again |
| The answer to a save is lost on a bad connection, and it looks like a conflict | The save's id is written down first; on return, a cloud copy carrying that id is recognised as ours |
| A damaged copy replaces good data | sha256, ledger checks and counts run before anything is touched; a snapshot is kept on the phone. A notebook that breaks a ledger rule is not sent, so no copy is made that no phone could open |
| A damaged current copy locks everybody out | An empty phone can still put an older copy back; a phone in use can save its own again (the damaged one is pinned) |
| A backup file restored over the notebook silently becomes everybody's copy | A "replace" restore drops the link with the copy and marks a new epoch: the next round asks, and a save that was on its way writes nothing down |
| "Sign out and remove" wipes the last copy | The cloud is asked at that moment, not the last save; an entry made meanwhile stops it |
| Photos go with a notebook that another phone removed | A snapshot with the photos is kept on the phone first |
| An empty phone empties the cloud | A phone without entries never replaces a copy that has some |
| An entry made while a copy is being applied is overwritten | The copy is applied in one transaction that first checks nothing changed since it was read |
| A's notebook goes into B's account on a shared phone | The notebook remembers its account, even an empty one (shop name, numbers), also when B deletes B's account; another account saves nothing until the person removes it or moves it on purpose |
| An older app overwrites a newer format | A newer format stops the save and asks to update |
| The cloud copy was deleted elsewhere and reappears, or the reverse | Each cloud copy has a lineage id; a different or missing one always asks |
| "Saved" is shown while nothing was | "Saved" is the server's confirmation only; an entry made during a save shows as waiting and is planned when the save ends |
| Somebody signs up with another person's address and keeps a way in | The linked Google address is shown, with a warning when it differs and a way to take it off; a password reset closes other sessions |

## Not in this version

- Two phones editing at the same moment in real time. They are reconciled at the next connection.
- Receipt photos. They stay on the phone and in the backup file (the free plan has no file storage), and the screen says how many.
- SMS codes, teams, sharing a notebook, reading from a computer without signing in.
- The demo notebook: never uploaded.
- Choosing record by record. A real conflict (the same name, date or debt changed differently on both phones) is one choice for the whole notebook; the other copy can be opened again, but not merged afterwards.

## Where things are

`users/{uid}` (Firestore) holds `lineage`, `rev`, the current version's id, `updatedAt` (server time) and the list of kept versions. `users/{uid}/parts/{version}-{n}` holds the compressed bytes, at most 900 KB each. One transaction writes the head and the parts and removes the versions that are no longer kept, so there are no half-saves and no orphans.

Kept versions: the current one, pinned ones, the newest 3, the last of each of the 7 latest days, 4 latest weeks and 6 latest months.

| File | Role |
|---|---|
| `lib/cloud/bundle.ts` | packs and opens a copy |
| `lib/cloud/merge.ts` | three-way comparison |
| `lib/cloud/sync.ts` | decides and applies; knows nothing about Firebase |
| `lib/cloud/firebase.ts` | Firebase (sign-in, Firestore); loaded only when used |
| `firestore.rules` | who may do what |
| `tests/cloud.test.ts`, `tests/emulator/` | tests without and with the Firebase emulators |

## Costs (measured 2026-11-25, without photos)

| One year of use | Records | Compressed copy |
|---|---:|---:|
| 20 people, 200 entries | 522 | 14 KB |
| 100 people, 2,000 entries | 5,102 | 104 KB |
| 300 people, 10,000 entries | 26,002 | 469 KB |

A save is 2 writes plus the removals. The free plan's 20,000 writes a day and 1 GiB should carry hundreds of shops (estimate). When the limit is reached, saves wait until the next day; the phone keeps working.

## Known risks

- The owner of the Firebase project can technically read every copy.
- A phone that still holds a sign-in ticket of a deleted account can write for up to an hour. It asks first ("the copy was deleted"); a copy saved then would belong to nobody.
- The two snapshots besides the newest that a phone keeps before combining hold its photos too, so they take room.
- Somebody could create many accounts, or fill one, to use up the free daily limit or the space: the rules limit the size and pace per account only (about 9 MB every 2 s). Firebase App Check would raise the cost of that; not set up.
- Law 18-07 / 25-11: other people's names, phones and debts are stored, probably abroad. To be checked with the ANPDP or a lawyer before opening to the public.
