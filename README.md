# Nuvio Bridge (AIOStreams için)

Nuvio scraper depolarını Stremio addon'una çevirir. Her depo ayrı addon olur.

## 1) TMDB API anahtarı al (ücretsiz)
themoviedb.org → hesap aç → Settings → API → "API Key (v3)" kopyala.

## 2) Sunucuyu çalıştır
### Hızlı deneme (kendi bilgisayarında)
1. Node.js 18+ kur (nodejs.org).
2. Bu klasörde terminal aç:
   npm install
   Windows:  set TMDB_API_KEY=ANAHTARIN && node server.js
   Mac/Linux: TMDB_API_KEY=ANAHTARIN node server.js
3. İnternete açmak için başka bir terminalde:
   cloudflared tunnel --url http://localhost:7000
   Çıkan https://....trycloudflare.com adresi senin sunucu adresin (her açılışta değişir).

### Kalıcı (Render.com, ücretsiz plan)
1. Bu klasörü bir GitHub deposuna yükle.
2. render.com → New → Web Service → depoyu seç → Runtime: Docker.
3. Environment bölümüne TMDB_API_KEY ekle → Deploy.
4. Verilen https://xxxx.onrender.com adresi sunucu adresin.

## 3) AIOStreams'e ekle
1. Sunucu adresini tarayıcıda aç: tüm manifest linkleri listelenir.
2. https://aiostreams.viren070.me → Addons → Custom (Add custom addon).
3. Manifest linkini yapıştır, ekle. Her depo için tekrarla:
   <sunucu>/repo/nuvio-providers/manifest.json
   <sunucu>/repo/phisher/manifest.json
   <sunucu>/repo/turkish-nuvio/manifest.json
   <sunucu>/repo/mooncrown/manifest.json
   <sunucu>/repo/wekmed/manifest.json

## Notlar
- Sağlık kontrolü: npm run selftest (tüm scraper dosyalarını yüklemeyi dener).
- Ayarlar (opsiyonel ortam değişkenleri): SCRAPER_TIMEOUT_MS, OVERALL_TIMEOUT_MS,
  CONCURRENCY, DISABLE_SCRAPERS=id1,id2, PUBLIC_URL.
- Bazı Türk siteleri yurt dışı/datacenter IP'lerini engeller; çalışmazsa evden (TR IP) çalıştırmayı dene.
- Siteler değiştikçe bazı scraper'lar bozulabilir; bu depo sahiplerinin güncellemesine bağlı.
