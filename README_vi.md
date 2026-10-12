# Wordwell

[English](README.md) | [Tiếng Việt](README_vi.md)

Wordwell giúp bạn học từ vựng và luyện viết IELTS trên máy tính. Bạn có thể lưu từ mới, ôn lại từ đã học và nhờ AI góp ý cho bài viết.

## Tải và mở ứng dụng

Cách đơn giản nhất cho Windows:

1. Mở [trang tải Wordwell](https://github.com/shynt-04/wordwell/releases/latest).
2. Trong phần **Assets**, tải tệp `Wordwell-1.0.0-portable-x64.exe`.
3. Đặt tệp vào một thư mục riêng, ví dụ trong Documents, rồi nhấp đúp để mở.

Bản này dành cho Windows 64-bit. Bạn không cần cài đặt ứng dụng hay cài thêm Node.js. Lần đầu mở có thể mất vài giây.

Windows có thể hiện cảnh báo vì ứng dụng chưa có chữ ký số. Chỉ mở tệp tải từ nguồn bạn tin tưởng.

## Bạn có thể làm gì?

- **Lưu từ mới:** Ghi nghĩa, phiên âm, từ đồng nghĩa, câu ví dụ và ghi chú. Bạn có thể tìm kiếm, sửa từ và nghe cách đọc.
- **Ôn từ theo hai cách:** Với **Understand**, nhìn từ rồi nhớ nghĩa. Với **Use it**, nhìn nghĩa rồi gõ lại từ. Mỗi cách có lịch ôn riêng. Chọn **Again** nếu muốn ôn lại sau một phút.
- **Nhờ AI điền thông tin:** Gợi ý nghĩa tiếng Anh, nghĩa tiếng Việt, phiên âm và ví dụ. Hãy kiểm tra trước khi lưu.
- **Học từ bài đọc hoặc bài nghe:** Dán bài đọc, bản chép lời bài nghe và câu hỏi. AI gợi ý từ nên học và giải thích cách từ trong câu hỏi liên quan đến từ trong bài.
- **Luyện viết IELTS:** Nhập đề và bài viết Task 1 hoặc Task 2 để nhận góp ý, sửa lỗi và điểm tham khảo. Có thể chọn góp ý bằng tiếng Việt.

## Bắt đầu học

Nếu chưa muốn dùng AI, chọn **Continue without AI**. Bạn vẫn có thể tự thêm từ và ôn tập khi không có mạng.

Để dùng AI, mở **Settings**:

1. Chọn dịch vụ AI, rồi nhập **API key**. Đây là mã do dịch vụ AI cấp, không phải mật khẩu tài khoản của bạn.
2. Nhấn **Connect & load models**, rồi chọn mô hình AI trong danh sách.
3. Nhấn **Save AI settings** để lưu.

Wordwell hỗ trợ DeepSeek, Gemini, Claude và các dịch vụ tương thích khác. Nếu dùng Ollama hoặc CLIProxyAPI trên máy tính, bạn cần cài và chạy dịch vụ đó trước.

AI trực tuyến cần mạng và có thể tính phí. Nội dung bạn gửi sẽ được chuyển đến dịch vụ AI đã chọn. AI có thể trả lời sai; điểm Writing chỉ để tham khảo, không phải kết quả thi IELTS.

### Lấy từ mới từ bài đọc và câu hỏi

1. Mở **From a passage**.
2. Dán nội dung bài và câu hỏi bằng chữ hoặc ảnh. Có thể dán ảnh bằng `Ctrl+V`, chọn ảnh từ máy hoặc kéo ảnh vào. Mỗi phần nhận tối đa 4 ảnh.
3. Nếu dùng ảnh, chọn mô hình đọc được ảnh và bật **Enable image input** trong Settings. Cho AI đọc ảnh, rồi kiểm tra và sửa phần chữ nhận được.
4. Xem các từ được gợi ý. AI sẽ chỉ ra từ đồng nghĩa, cách diễn đạt khác hoặc từ có liên quan trong câu hỏi, nếu tìm được.
5. Sửa thẻ nếu cần, rồi chọn những thẻ bạn muốn lưu. Wordwell không tự thêm tất cả từ vào sổ.

Nội dung bài chưa lưu chỉ nằm trong cửa sổ đang mở. Đừng đóng cửa sổ trước khi lưu các thẻ bạn cần. Tính năng này nhận chữ và ảnh, không nhận tệp âm thanh.

## Giữ dữ liệu an toàn

Ứng dụng tạo thư mục `data` bên cạnh tệp `.exe`:

- `data/wordwell.sqlite`: Từ vựng, lịch ôn và bản nháp Writing đã lưu.
- `data/ai-settings.json`: Cài đặt AI và API key. Mã được lưu dưới dạng chữ thông thường, không được mã hóa. Đừng chia sẻ tệp này.

Muốn chuyển ứng dụng sang chỗ khác, hãy đóng Wordwell rồi chuyển cả tệp `.exe` và thư mục `data`. Đừng rút USB khi ứng dụng còn mở.

Muốn gửi ứng dụng cho bạn bè, chỉ gửi tệp `.exe`. Không gửi thư mục `data` hoặc tệp `.env` có thông tin riêng.

Để sao lưu, vào **Backup & restore**, chọn **Download SQLite backup**. Bản sao này chứa dữ liệu học, nhưng không chứa API key. Muốn khôi phục, đóng ứng dụng, giữ một bản sao dữ liệu hiện tại, rồi thay `data/wordwell.sqlite` bằng tệp sao lưu.

Bản web và bản ứng dụng lưu dữ liệu riêng. Xem [hướng dẫn bản ứng dụng](portable-app/README.md) nếu muốn chuyển dữ liệu từ bản web sang.

## Chạy bản web từ mã nguồn

Nếu muốn chạy trên trình duyệt, bạn cần Node.js 24 trở lên và Git:

```sh
git clone https://github.com/shynt-04/wordwell.git
cd wordwell
npm start
```

Mở [http://127.0.0.1:4173](http://127.0.0.1:4173). Giữ cửa sổ dòng lệnh mở khi dùng; nhấn `Ctrl+C` để dừng. Trên Windows, cũng có thể nhấp đúp `start-wordwell.cmd` sau khi tải mã nguồn và cài Node.js.

## Dành cho người sửa mã nguồn

- `npm test`: Chạy các bài kiểm tra tự động.
- `npm run dev`: Chạy bản web và tự khởi động lại máy chủ khi sửa mã.
- `npm --prefix portable-app ci`: Cài công cụ để làm bản ứng dụng.
- `npm run app:dev`: Mở bản ứng dụng để thử khi sửa mã.
- `npm run app:build`: Tạo tệp `.exe` trong `portable-app/release/`.
- `npm run app:test`: Kiểm tra bản ứng dụng đã tạo bằng dữ liệu thử riêng.

## Giấy phép

Mã nguồn dùng [giấy phép GPL v3](LICENSE).
