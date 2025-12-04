// FILE: functions/index.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors')({origin: true});
const Groq = require('groq-sdk');
const { google } = require('googleapis');

admin.initializeApp();
const db = admin.firestore();

// Khởi tạo Groq
const groq = new Groq({
  apiKey: functions.config().groq.key
});

// ============================================
// FUNCTION 1: Upload PDF lên Google Drive
// ============================================
exports.uploadToGDrive = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      const { fileName, fileBase64, subject, sessionDate } = req.body;

      // Setup Google Drive OAuth
      const oauth2Client = new google.auth.OAuth2(
        functions.config().google.client_id,
        functions.config().google.client_secret,
        functions.config().google.redirect_uri
      );
      
      oauth2Client.setCredentials({
        refresh_token: functions.config().google.refresh_token
      });

      const drive = google.drive({ version: 'v3', auth: oauth2Client });

      // Tạo/tìm folder theo ngày
      const folderName = sessionDate.split('T')[0]; // 2025-01-15
      const folderId = await getOrCreateFolder(drive, folderName);

      // Upload file
      const fileMetadata = {
        name: fileName,
        parents: [folderId]
      };

      const media = {
        mimeType: 'application/pdf',
        body: Buffer.from(fileBase64, 'base64')
      };

      const uploadResponse = await drive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: 'id, webViewLink'
      });

      // Lưu metadata vào Firestore
      await db.collection('submissions').add({
        fileId: uploadResponse.data.id,
        fileName: fileName,
        subject: subject,
        sessionDate: sessionDate,
        driveUrl: uploadResponse.data.webViewLink,
        uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'uploaded'
      });

      res.json({
        success: true,
        fileId: uploadResponse.data.id,
        driveUrl: uploadResponse.data.webViewLink
      });

    } catch (error) {
      console.error('Upload Error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });
});

// Helper: Tạo hoặc tìm folder
async function getOrCreateFolder(drive, folderName) {
  const rootFolderId = functions.config().google.root_folder_id;

  // Tìm folder tồn tại
  const searchResponse = await drive.files.list({
    q: `name='${folderName}' and '${rootFolderId}' in parents and mimeType='application/vnd.google-apps.folder'`,
    fields: 'files(id, name)'
  });

  if (searchResponse.data.files.length > 0) {
    return searchResponse.data.files[0].id;
  }

  // Tạo folder mới
  const folderMetadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [rootFolderId]
  };

  const createResponse = await drive.files.create({
    requestBody: folderMetadata,
    fields: 'id'
  });

  return createResponse.data.id;
}

// ============================================
// FUNCTION 2: Chấm bài với Groq API
// ============================================
exports.gradeAssignment = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      const { submissionId, fileBase64, subject, totalQuestions } = req.body;

      // Tạo prompt theo môn
      let systemPrompt = '';
      
      if (subject.includes('Toán') || subject.includes('Math')) {
        systemPrompt = `Bạn là giáo viên Toán giỏi. Chấm bài tập lớp 8.

BƯỚC 1: Kiểm tra từng đáp án (đúng/sai)
BƯỚC 2: Đánh giá lời giải (logic, các bước, trình bày)
BƯỚC 3: Cho điểm từng câu (0-10)

QUAN TRỌNG: Với môn Toán, hãy THỬ TÍNH đáp án của học sinh xem có đúng không trước khi chấm.

Trả về JSON:
{
  "totalScore": 85,
  "maxScore": 100,
  "percentage": 85,
  "questions": [
    {
      "number": 1,
      "answerCorrect": true,
      "score": 9,
      "maxScore": 10,
      "feedback": "Đáp án đúng. Lời giải rõ ràng. Có thể trình bày gọn hơn."
    }
  ],
  "strengths": ["Tính toán chính xác", "Lập luận logic"],
  "improvements": ["Cần viết rõ đơn vị", "Trình bày dễ đọc hơn"],
  "overall": "Làm bài tốt! Tiếp tục phát huy..."
}`;

      } else if (subject.includes('FCE')) {
        systemPrompt = `Bạn là giám khảo FCE Cambridge. Chấm theo rubric chính thức.

FCE WRITING CRITERIA (mỗi tiêu chí 0-5 điểm):
- Content: Có đủ ý? Trả lời đúng yêu cầu?
- Communicative Achievement: Phong cách phù hợp? Đạt mục đích?
- Organisation: Bố cục logic? Linking words?
- Language: Ngữ pháp, từ vựng đa dạng? Sai sót ít?

MỤC TIÊU: Đạt C1 (180 điểm) = 16-20/20

Trả về JSON:
{
  "totalScore": 17,
  "maxScore": 20,
  "percentage": 85,
  "cefrLevel": "B2",
  "targetLevel": "C1",
  "criteria": {
    "content": 4,
    "communicative": 5,
    "organisation": 4,
    "language": 4
  },
  "strengths": ["Clear structure", "Good vocabulary range"],
  "improvements": ["Use more complex sentences", "Fewer grammar errors"],
  "specificFeedback": [
    "Line 3: 'I am agree' → 'I agree'",
    "Paragraph 2: Add linking word before conclusion"
  ],
  "overall": "Good B2 level. To reach C1: ..."
}`;
      }

      // Gọi Groq API
      const completion = await groq.chat.completions.create({
        model: "llama-3.2-90b-vision-preview",
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Hãy chấm bài tập này (${totalQuestions} câu). Phân tích kỹ và trả về JSON như yêu cầu.`
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:application/pdf;base64,${fileBase64}`
                }
              }
            ]
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.3 // Ít ngẫu nhiên, chấm chính xác hơn
      });

      const gradingResult = JSON.parse(completion.choices[0].message.content);

      // Lưu kết quả vào Firestore
      await db.collection('submissions').doc(submissionId).update({
        gradingResult: gradingResult,
        gradedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'graded'
      });

      res.json({
        success: true,
        result: gradingResult
      });

    } catch (error) {
      console.error('Grading Error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });
});

// ============================================
// FUNCTION 3: Lấy danh sách submissions
// ============================================
exports.getSubmissions = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      const { startDate, endDate } = req.query;

      let query = db.collection('submissions');
      
      if (startDate && endDate) {
        query = query
          .where('sessionDate', '>=', startDate)
          .where('sessionDate', '<=', endDate);
      }

      const snapshot = await query.orderBy('uploadedAt', 'desc').get();
      
      const submissions = [];
      snapshot.forEach(doc => {
        submissions.push({ id: doc.id, ...doc.data() });
      });

      res.json({ success: true, data: submissions });

    } catch (error) {
      console.error('Get Submissions Error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });
});
