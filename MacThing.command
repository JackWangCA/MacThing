#!/bin/zsh
# Double-click this in Finder to set MacThing up — it's the same as running ./macthing setup
# in a terminal, but without needing one. Finder opens .command files in Terminal.
cd "${0:A:h}"
./macthing setup
status=$?
print
if (( status == 0 )); then
  print -- "Done. You can close this window — the bridge keeps running on its own."
else
  print -- "That didn't finish. The message above says why."
fi
print -- "Press return to close."
read -r
exit $status
