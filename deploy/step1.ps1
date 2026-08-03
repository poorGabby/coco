$gc = "C:\Users\QQ\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$log = "e:\hermes\gcloud-last.log"
Remove-Item $log -ErrorAction SilentlyContinue
& $gc auth activate-service-account --key-file=e:\hermes\hermes-deployer-key.json 2>&1 | Tee-Object -FilePath $log -Append
& $gc config set project furever-dock-hermes-agent 2>&1 | Tee-Object -FilePath $log -Append
$status = & $gc builds describe 75b208d2-75d6-4702-bf4d-cf878a4de440 --format="value(status)" 2>&1
"BUILD_STATUS=$status" | Tee-Object -FilePath $log -Append
