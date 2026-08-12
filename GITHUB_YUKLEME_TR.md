# GitHub'a yükleme

Bu paket, PolicyLint-DLP v0.2.1 kaynak kodunu, testlerini, deney betiklerini,
ham deney sonuçlarını ve yayın grafiklerini içerir. `node_modules/`, geçici
dosyalar, makale taslakları ve üçüncü taraf SPEDIA CSV dosyası pakete dahil
edilmemiştir.

## Önerilen yöntem

1. GitHub deposunu bilgisayarınıza klonlayın:

   ```bash
   git clone https://github.com/fatihkaplanfk/policyLint-dlp.git
   cd policyLint-dlp
   ```

2. ZIP içindeki `PolicyLint-DLP-v0.2.1` klasörünün **içeriğini** depo köküne
   kopyalayın. Mevcut dosyaların üzerine yazılmasına izin verin.

3. Temiz kurulum ve doğrulama yapın:

   ```bash
   npm ci
   npm test
   npm run lint
   ```

4. Dosyaları gönderin:

   ```bash
   git add .
   git commit -m "Add PolicyLint-DLP v0.2.1 reproducibility package"
   git push
   ```

5. İsterseniz GitHub Releases bölümünde `v0.2.1` etiketiyle bir sürüm
   oluşturun ve aynı ZIP dosyasını sürüm varlığı olarak ekleyin.

SPEDIA CSV dosyası depoda ayrıca tutulacaksa `data/ATTRIBUTION.md` dosyasını
koruyun. Deney betiğinin varsayılan yolu `data/raw/logs_SPEDIA_annotated_en.csv`
olduğundan, CSV başka konumdaysa `--dataset` parametresiyle açık yol verin.
