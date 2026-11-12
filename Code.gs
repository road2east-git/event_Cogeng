/**
 * ============================================================================
 * 한광희 교수님 정년퇴임 기념 ‘감사의 밤’ 자료 수집 서버리스 스크립트 (Code.gs)
 * ============================================================================
 * - 별도 유료 서버 없이 구글 시트(Google Sheets) + 구글 드라이브(Google Drive)만으로 작동합니다.
 * - 동문이 제출할 때마다 지정된 드라이브 폴더 안에 [학번_이름_날짜] 하위 폴더가 자동 생성됩니다.
 * - 사진마다 입력한 [촬영년도 / 장소 및 행사 / 등장인물 / 메모]가 파일명과 파일 설명에 자동 기록됩니다.
 * - 대용량 동영상 축사(20MB 초과)도 Google Drive Resumable Upload API를 통해 안전하게 분할 저장됩니다.
 */

// 지정된 구글 드라이브 폴더("한광희 교수님 정년퇴임 기념 감사의 밤") ID
const ROOT_FOLDER_ID = "1zxMwlOEjcf0gdGNayOPO4anBlJ-tUkOj";
const DEFAULT_ROOT_FOLDER_NAME = "한광희 교수님 정년퇴임 기념 감사의 밤";

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action;

    if (action === "initSubmission") {
      return jsonResponse(handleInitSubmission(payload));
    } else if (action === "uploadFile") {
      return jsonResponse(handleUploadFile(payload));
    } else if (action === "uploadChunk") {
      return jsonResponse(handleUploadChunk(payload));
    }

    return jsonResponse({ ok: false, error: "알 수 없는 요청(action)입니다: " + action });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || String(err) });
  }
}

/**
 * 1단계: 시트에 응답 행 추가 + 동문별 전용 하위 폴더 생성
 */
function handleInitSubmission(data) {
  const sheet = getOrCreateArchiveSheet();
  const rootFolder = getOrCreateRootFolder();

  const timestamp = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm:ss");
  const dateShort = Utilities.formatDate(new Date(), "Asia/Seoul", "MMdd_HHmm");
  const safeGrad = sanitizeName(data.gradYear || "학번미상");
  const safeName = sanitizeName(data.alumniName || "이름미상");

  // 동문별 하위 폴더 생성 (예: [2016석사_홍길동_1112_2245])
  const subFolderName = `[${safeGrad}_${safeName}_${dateShort}]`;
  const subFolder = rootFolder.createFolder(subFolderName);
  const subFolderUrl = subFolder.getUrl();

  // 시트 행 기록:
  // [제출일시, 성함, 졸업년도/학번, 근황 및 인사말, 사진별 상세정보 요약, 첨부 사진수, 첨부 영상수, 드라이브 폴더 링크, 업로드된 파일 목록]
  sheet.appendRow([
    timestamp,
    data.alumniName || "",
    data.gradYear || "",
    data.alumniUpdate || "",
    data.photoSummary || "(사진 설명 없음)",
    data.photoCount || 0,
    data.videoCount || 0,
    subFolderUrl,
    ""
  ]);

  const rowNumber = sheet.getLastRow();

  return {
    ok: true,
    folderId: subFolder.getId(),
    folderUrl: subFolderUrl,
    rowNumber: rowNumber
  };
}

/**
 * 2단계: 일반 사진 및 20MB 이하 동영상 단일 업로드
 */
function handleUploadFile(data) {
  const folder = DriveApp.getFolderById(data.folderId);
  const decoded = Utilities.base64Decode(data.base64Data);
  const blob = Utilities.newBlob(decoded, data.mimeType, data.fileName);
  const file = folder.createFile(blob);

  // 사진 메타데이터가 있으면 구글 드라이브 파일 설명(Description)에도 저장
  if (data.meta) {
    const descParts = [];
    if (data.meta.year) descParts.push("촬영년도: " + data.meta.year);
    if (data.meta.eventPlace) descParts.push("장소/행사: " + data.meta.eventPlace);
    if (data.meta.people) descParts.push("등장인물: " + data.meta.people);
    if (data.meta.note) descParts.push("에피소드: " + data.meta.note);
    if (descParts.length > 0) {
      file.setDescription(descParts.join(" | "));
    }
  }

  appendFileUrlToSheetRow(data.rowNumber, `${data.fileName} (${file.getUrl()})`);

  return {
    ok: true,
    fileId: file.getId(),
    fileUrl: file.getUrl()
  };
}

/**
 * 3단계: 20MB 초과 대용량 동영상 분할(Chunk) 업로드 (Google Drive Resumable Upload API)
 */
function handleUploadChunk(data) {
  let resumableUrl = data.resumableUrl;

  // 첫 번째 청크일 때 Resumable 세션 시작
  if (data.chunkIndex === 0 || !resumableUrl) {
    const metadata = {
      name: data.fileName,
      mimeType: data.mimeType || "video/mp4",
      parents: [data.folderId]
    };

    const initRes = UrlFetchApp.fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
      {
        method: "post",
        contentType: "application/json; charset=UTF-8",
        headers: {
          Authorization: "Bearer " + ScriptApp.getOAuthToken(),
          "X-Upload-Content-Type": data.mimeType || "video/mp4",
          "X-Upload-Content-Length": String(data.totalFileSize)
        },
        payload: JSON.stringify(metadata),
        muteHttpExceptions: true
      }
    );

    const headers = initRes.getAllHeaders();
    resumableUrl = headers["Location"] || headers["location"];
    if (!resumableUrl) {
      throw new Error("대용량 업로드 세션 생성 실패: " + initRes.getContentText());
    }
  }

  // 해당 청크 바이트 전송
  const chunkBytes = Utilities.base64Decode(data.base64Chunk);
  const contentRange = `bytes ${data.byteStart}-${data.byteEnd}/${data.totalFileSize}`;

  const putRes = UrlFetchApp.fetch(resumableUrl, {
    method: "put",
    headers: {
      "Content-Range": contentRange
    },
    payload: chunkBytes,
    muteHttpExceptions: true
  });

  const code = putRes.getResponseCode();
  // 308 Resume Incomplete = 다음 청크 계속, 200 또는 201 = 최종 업로드 완료
  if (code === 200 || code === 201) {
    const fileInfo = JSON.parse(putRes.getContentText());
    const fileUrl = `https://drive.google.com/file/d/${fileInfo.id}/view`;
    appendFileUrlToSheetRow(data.rowNumber, `${data.fileName} (${fileUrl})`);
    return {
      ok: true,
      done: true,
      resumableUrl: resumableUrl,
      fileId: fileInfo.id,
      fileUrl: fileUrl
    };
  } else if (code === 308) {
    return {
      ok: true,
      done: false,
      resumableUrl: resumableUrl
    };
  } else {
    throw new Error(`청크 전송 오류 (HTTP ${code}): ${putRes.getContentText()}`);
  }
}

/**
 * 시트 헤더 자동 생성 및 반환
 */
function getOrCreateArchiveSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("자료수집_응답");
  if (!sheet) {
    sheet = ss.getActiveSheet();
  }

  if (sheet.getLastRow() === 0) {
    const headers = [
      "제출일시",
      "성함",
      "졸업(예정)년도",
      "근황 및 교수님께 드리는 인사",
      "사진별 상세 설명 (연도/장소/등장인물)",
      "사진 수",
      "영상 수",
      "동문 전용 드라이브 폴더",
      "개별 파일 링크 목록"
    ];
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length)
      .setBackground("#0A2246")
      .setFontColor("#FFFFFF")
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * 루트 아카이브 폴더 가져오기 (없으면 자동 생성)
 */
function getOrCreateRootFolder() {
  if (ROOT_FOLDER_ID && ROOT_FOLDER_ID.trim() !== "") {
    return DriveApp.getFolderById(ROOT_FOLDER_ID.trim());
  }
  const folders = DriveApp.getFoldersByName(DEFAULT_ROOT_FOLDER_NAME);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(DEFAULT_ROOT_FOLDER_NAME);
}

/**
 * 업로드된 파일 링크를 해당 동문의 시트 행(9번째 열)에 누적 기록
 */
function appendFileUrlToSheetRow(rowNumber, fileEntryText) {
  if (!rowNumber) return;
  const sheet = getOrCreateArchiveSheet();
  const cell = sheet.getRange(Number(rowNumber), 9);
  const prev = cell.getValue();
  cell.setValue(prev ? prev + "\n" + fileEntryText : fileEntryText);
}

function sanitizeName(str) {
  return String(str).replace(/[\\/:*?"<>|]/g, "_").trim();
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
