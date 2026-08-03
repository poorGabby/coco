$gc='C:\Users\QQ\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'
$tag='v-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$image='us-central1-docker.pkg.dev/furever-dock-hermes-agent/hermes-agent/gateway:' + $tag
$id = & $gc builds submit 'C:\Users\QQ\AppData\Local\Temp\hermes-build\src' --config=e:\hermes\deploy\cloudbuild.yaml --substitutions=_IMAGE=$image,_GIT_SHA=77a1650c78a4cb1813d8a81fa1da40a15b6a3ec5 --async --format='value(id)'
"$id
$image" | Set-Content e:\hermes\build-id.txt
Write-Host BUILD_ID=$id
Write-Host IMAGE=$image
