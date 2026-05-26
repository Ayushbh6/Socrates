$ErrorActionPreference = "Stop"

$Repo = $env:SOCRATES_RELEASE_REPO
if ([string]::IsNullOrWhiteSpace($Repo)) {
  $Repo = "Ayushbh6/Socrates"
}

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "This first Socrates installer supports Windows x64 only."
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("socrates-install-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TempDir | Out-Null

try {
  $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
  $InstallerAsset = $Release.assets | Where-Object { $_.name -like "*-setup.exe" } | Select-Object -First 1
  $SumsAsset = $Release.assets | Where-Object { $_.name -eq "SHA256SUMS" } | Select-Object -First 1

  if (-not $InstallerAsset) {
    throw "No Windows setup EXE asset found in the latest release."
  }
  if (-not $SumsAsset) {
    throw "No SHA256SUMS asset found in the latest release."
  }

  $InstallerPath = Join-Path $TempDir $InstallerAsset.name
  $SumsPath = Join-Path $TempDir "SHA256SUMS"
  Invoke-WebRequest -Uri $InstallerAsset.browser_download_url -OutFile $InstallerPath
  Invoke-WebRequest -Uri $SumsAsset.browser_download_url -OutFile $SumsPath

  $Expected = (Get-Content $SumsPath | Where-Object { $_ -match "\s$([Regex]::Escape($InstallerAsset.name))$" } | ForEach-Object { ($_ -split "\s+")[0] } | Select-Object -First 1)
  $Actual = (Get-FileHash -Algorithm SHA256 $InstallerPath).Hash.ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($Expected) -or $Expected.ToLowerInvariant() -ne $Actual) {
    throw "Checksum verification failed for $InstallerPath"
  }

  Write-Host "Downloaded and verified $InstallerPath"
  Start-Process -FilePath $InstallerPath -Wait
} finally {
  if (Test-Path $TempDir) {
    Remove-Item -Recurse -Force $TempDir
  }
}
