# Cài đặt iShot trên macOS

## Bước 1: Tải và cài đặt

1. Tải file `iShot_x.x.x_aarch64.dmg`
2. Mở file DMG
3. Kéo iShot vào thư mục Applications

## Bước 2: Mở app lần đầu (BẮT BUỘC)

Do app chưa được notarize với Apple, bạn cần làm **MỘT trong các cách** sau:

### Cách 1: Click chuột phải (Khuyến nghị)
1. Mở Finder → Applications
2. **Click chuột phải** (hoặc Control + Click) vào iShot
3. Chọn **"Open"** từ menu
4. Click **"Open"** trong dialog xác nhận

### Cách 2: Dùng Terminal
```bash
xattr -cr /Applications/iShot.app
```
Sau đó mở app bình thường.

### Cách 3: System Settings
1. Double-click vào iShot (sẽ bị chặn)
2. Mở **System Settings → Privacy & Security**
3. Cuộn xuống tìm thông báo về iShot
4. Click **"Open Anyway"**

---

**Lưu ý:** Chỉ cần làm 1 lần. Sau đó app sẽ mở bình thường.
