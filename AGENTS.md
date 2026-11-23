# Working on OtoHari

Use main for Android and ios for the iPhone. Work in mobile/ for the app. Keep changes to the shared DN sources in frontend/ and the corresponding upstream contribution small enough to review independently.

Use the Node and pnpm versions pinned in the project. Run the affected mobile checks and the production web build. Installations and downloads rely on the existing platform application identifiers, Android package signature and updater asset names.

Keep signing material outside Git. Release tags, signing, publishing, or TestFlight uploads need explicit authorization. Stage files by name, use conventional commit subjects and describe the reason for the change in the commit body.
