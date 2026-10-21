# Nomad DMX Desk on iPad

The iPad app is built as an **unsigned** `.ipa` (`NomadDMX-<version>-unsigned.ipa`, from the "iPad app" GitHub Action).
Apple only lets an app run on your iPad if it is signed. With a free Apple ID that signature lasts **7 days**, so something has to re-sign it
every week. AltStore does that automatically from your Windows PC or Mac.

## One-time setup (AltStore)

1. On your computer install **AltServer** from https://altstore.io (Windows also needs iTunes and iCloud from apple.com, not the Microsoft Store versions).
2. Plug the iPad in with a cable, open AltServer, and choose **Install AltStore** to your iPad. Sign in with an Apple ID
   (a spare Apple ID just for this is a good idea).
3. On the iPad: Settings > General > VPN & Device Management > trust your Apple ID.
   Settings > Privacy & Security > **Developer Mode** > On (the iPad restarts).
4. Get the `.ipa` onto the iPad (AirDrop, iCloud Drive, or Files). Open **AltStore** > My Apps > **+** > pick the `.ipa`.
5. First time the app opens, allow **Local Network** and **Bluetooth** when asked.

## Weekly re-signing (automatic)

- Keep AltServer running on your computer (set it to start at login) and the computer on the **same Wi-Fi** as the iPad at least once a week.
- Turn on Wi-Fi sync for the iPad (Finder or iTunes: "Show this iPad when on Wi-Fi").
- In AltStore > Settings turn on **Background Refresh**. AltStore refreshes the app before the 7 days run out.
- If it ever expires, plug the iPad in and press Refresh All in AltStore > My Apps. Your show is kept.

Free Apple ID limits: apps last 7 days, 3 sideloaded apps at once (AltStore counts as one), 10 new app IDs per week.

Alternatives: Sideloadly (Windows/Mac) has its own refresh option; SideStore can refresh on the iPad without a computer but is harder to set up.

## Things that work differently on iPad

- The desk runs inside the app, so **keep the app open on screen** while the lights run. iPadOS pauses background apps and the DMX stops. The iPad is kept awake while the app is open.
- Wi-Fi can't be scanned or joined from an app: pick the network in Settings > Wi-Fi.
- **sACN multicast** needs an Apple entitlement that free accounts can't have. Use Art-Net, or sACN to a node's address.
- Finding Art-Net nodes sends a poll to the broadcast address and to every address on the local network. If your node still isn't found, type its address under Output > Advanced.
