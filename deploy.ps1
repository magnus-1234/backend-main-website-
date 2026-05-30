$IpAddress = "140.245.201.209"
$Username = "ubuntu"
$KeyPath = "C:\Users\mohit\.gemini\antigravity-ide\brain\43112372-1fb9-4c12-aedd-9cfc585e12a3\ssh-key.key"
$RemoteDir = "/home/ubuntu/whiteoutsurvival_dev_backend"

Write-Host "Archiving backend files..."
Compress-Archive -Path src, package.json, package-lock.json, tsconfig.json, ecosystem.config.js -DestinationPath backend.zip -Force

Write-Host "Creating remote directory..."
ssh -i $KeyPath -o StrictHostKeyChecking=no ${Username}@${IpAddress} "mkdir -p $RemoteDir"

Write-Host "Transferring archive..."
scp -i $KeyPath -o StrictHostKeyChecking=no backend.zip ${Username}@${IpAddress}:${RemoteDir}/

Write-Host "Extracting and installing on remote..."
$RemoteCommands = @"
cd $RemoteDir
unzip -o backend.zip
npm install
npm run build
npx pm2 delete whiteoutsurvival_backend 2>/dev/null || true
npx pm2 start ecosystem.config.js
npx pm2 save
curl -s localhost:3001/api/health
"@
ssh -i $KeyPath -o StrictHostKeyChecking=no ${Username}@${IpAddress} $RemoteCommands

Write-Host "Cleaning up local archive..."
Remove-Item backend.zip

Write-Host "Deployment complete! Backend should be running on the Oracle VM."
