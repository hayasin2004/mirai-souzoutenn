/**
 * Mirai Face Mirror - リアルタイム 2.5D リアル顔アバターエンジン
 *
 * 特徴:
 * - 1枚の顔写真からでも MediaPipe 478点 3Dランドマーク（＋自動フォールバック検出）で立体メッシュを自動生成
 * - 複数枚の写真（通常・口開け・笑顔）を登録した場合は表情・口内テクスチャをリアルタイムにマルチブレンド
 * - 上唇・下唇の分離メッシュ＋リアルな口内（上の歯・舌・口内陰影）レンダリングにより、口閉じ写真1枚でも自然に喋る
 * - Web Audio API の周波数フォルマント解析＋日本語テキスト母音推定による60fpsゼロ遅延リップシンク
 * - 自然なまばたき、呼吸、発話リズムに合わせた首の立体的な揺れ・うなずき、視線追従
 */

"use strict";

(function (global) {
  // MediaPipe Face Landmarker の主要インデックス定義
  const MP_INDICES = {
    noseTip: 1,
    noseBridge: 6,
    chin: 152,
    forehead: 10,
    leftEyeOuter: 33,
    leftEyeInner: 133,
    leftEyeTop: 159,
    leftEyeBottom: 145,
    rightEyeInner: 362,
    rightEyeOuter: 263,
    rightEyeTop: 386,
    rightEyeBottom: 374,
    leftBrowOuter: 70,
    leftBrowMid: 105,
    leftBrowInner: 107,
    rightBrowInner: 336,
    rightBrowMid: 334,
    rightBrowOuter: 300,
    mouthLeft: 61,
    mouthRight: 291,
    upperLipTop: 0,
    upperLipBottom: 13,
    lowerLipTop: 14,
    lowerLipBottom: 17,
    leftCheek: 234,
    rightCheek: 454,
    leftJaw: 172,
    rightJaw: 397,
  };

  /**
   * 2D/2.5D アフィン変換で三角形テクスチャを描画するヘルパー
   */
  function drawTexturedTriangle(ctx, img, u0, v0, u1, v1, u2, v2, x0, y0, x1, y1, x2, y2) {
    // 縮退三角形のスキップ
    const detSource = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    if (Math.abs(detSource) < 1e-5) return;

    // 境界の隙間（シーム）を防ぐため重心からわずかに拡大
    const cx = (x0 + x1 + x2) / 3;
    const cy = (y0 + y1 + y2) / 3;
    const expand = 0.45;
    const ex = (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      const len = Math.hypot(dx, dy) || 1;
      return [x + (dx / len) * expand, y + (dy / len) * expand];
    };
    const [px0, py0] = ex(x0, y0);
    const [px1, py1] = ex(x1, y1);
    const [px2, py2] = ex(x2, y2);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(px0, py0);
    ctx.lineTo(px1, py1);
    ctx.lineTo(px2, py2);
    ctx.closePath();
    ctx.clip();

    const du1 = u1 - u0;
    const dv1 = v1 - v0;
    const du2 = u2 - u0;
    const dv2 = v2 - v0;

    const dx1 = x1 - x0;
    const dy1 = y1 - y0;
    const dx2 = x2 - x0;
    const dy2 = y2 - y0;

    const invDet = 1 / detSource;
    const a = (dv2 * dx1 - dv1 * dx2) * invDet;
    const b = (dv2 * dy1 - dv1 * dy2) * invDet;
    const c = (-du2 * dx1 + du1 * dx2) * invDet;
    const d = (-du2 * dy1 + du1 * dy2) * invDet;
    const e = x0 - a * u0 - c * v0;
    const f = y0 - b * u0 - d * v0;

    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  /**
   * 顔の特徴アンカー（正規化座標 0.0〜1.0）のデフォルト値
   * MediaPipe が読み込めない環境やイラスト・証明写真でも即座に立体メッシュを構築可能
   */
  function createDefaultAnchors() {
    return {
      // 顔中心・輪郭
      faceCenter: { x: 0.50, y: 0.46 },
      forehead: { x: 0.50, y: 0.22 },
      noseBridge: { x: 0.50, y: 0.39 },
      noseTip: { x: 0.50, y: 0.50 },
      chin: { x: 0.50, y: 0.77 },
      leftCheek: { x: 0.27, y: 0.48 },
      rightCheek: { x: 0.73, y: 0.48 },
      leftJaw: { x: 0.32, y: 0.66 },
      rightJaw: { x: 0.68, y: 0.66 },

      // 左目（向かって左）
      leftEyeOuter: { x: 0.34, y: 0.40 },
      leftEyeInner: { x: 0.44, y: 0.405 },
      leftEyeTop: { x: 0.39, y: 0.382 },
      leftEyeBottom: { x: 0.39, y: 0.418 },

      // 右目（向かって右）
      rightEyeInner: { x: 0.56, y: 0.405 },
      rightEyeOuter: { x: 0.66, y: 0.40 },
      rightEyeTop: { x: 0.61, y: 0.382 },
      rightEyeBottom: { x: 0.61, y: 0.418 },

      // 眉
      leftBrowOuter: { x: 0.32, y: 0.34 },
      leftBrowMid: { x: 0.385, y: 0.325 },
      leftBrowInner: { x: 0.45, y: 0.34 },
      rightBrowInner: { x: 0.55, y: 0.34 },
      rightBrowMid: { x: 0.615, y: 0.325 },
      rightBrowOuter: { x: 0.68, y: 0.34 },

      // 口・唇
      mouthLeft: { x: 0.41, y: 0.615 },
      mouthRight: { x: 0.59, y: 0.615 },
      upperLipTop: { x: 0.50, y: 0.592 },
      lipCenter: { x: 0.50, y: 0.615 },
      lowerLipBottom: { x: 0.50, y: 0.642 },
    };
  }

  /**
   * 画像の肌色・明暗対比から顔の位置を簡易推定するスマートフォールバック
   */
  function estimateFaceAnchorsFromImage(img) {
    const anchors = createDefaultAnchors();
    try {
      const w = 128;
      const h = 128;
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const octx = off.getContext("2d");
      octx.drawImage(img, 0, 0, w, h);
      const data = octx.getImageData(0, 0, w, h).data;

      // 肌色らしき領域の重心を計算
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      let minX = w, maxX = 0, minY = h, maxY = 0;

      for (let y = Math.floor(h * 0.1); y < Math.floor(h * 0.88); y++) {
        for (let x = Math.floor(w * 0.15); x < Math.floor(w * 0.85); x++) {
          const idx = (y * w + x) * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          // 肌色ヒューリスティック (RGB & YCbCr)
          const isSkin =
            r > 85 &&
            g > 40 &&
            b > 25 &&
            r > g &&
            r > b &&
            Math.abs(r - g) > 10 &&
            r - b > 15;
          if (isSkin) {
            sumX += x;
            sumY += y;
            count++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (count > w * h * 0.06) {
        const cx = (sumX / count) / w;
        const cy = (sumY / count) / h;
        const fw = Math.min(0.68, Math.max(0.32, (maxX - minX) / w));
        const fh = Math.min(0.74, Math.max(0.38, (maxY - minY) / h));
        return buildAnchorsFromBox(cx, cy, fw, fh);
      }
    } catch (e) {
      console.warn("簡易顔領域推定スキップ:", e);
    }
    return anchors;
  }

  function buildAnchorsFromBox(cx, cy, fw, fh) {
    const rx = fw * 0.5;
    const ry = fh * 0.5;
    const eyeY = cy - ry * 0.16;
    const browY = cy - ry * 0.34;
    const noseY = cy + ry * 0.08;
    const mouthY = cy + ry * 0.38;
    const chinY = cy + ry * 0.78;

    return {
      faceCenter: { x: cx, y: cy },
      forehead: { x: cx, y: cy - ry * 0.68 },
      noseBridge: { x: cx, y: eyeY + (noseY - eyeY) * 0.2 },
      noseTip: { x: cx, y: noseY },
      chin: { x: cx, y: Math.min(0.92, chinY) },
      leftCheek: { x: cx - rx * 0.85, y: cy + ry * 0.04 },
      rightCheek: { x: cx + rx * 0.85, y: cy + ry * 0.04 },
      leftJaw: { x: cx - rx * 0.68, y: cy + ry * 0.48 },
      rightJaw: { x: cx + rx * 0.68, y: cy + ry * 0.48 },

      leftEyeOuter: { x: cx - rx * 0.58, y: eyeY },
      leftEyeInner: { x: cx - rx * 0.22, y: eyeY + ry * 0.01 },
      leftEyeTop: { x: cx - rx * 0.40, y: eyeY - ry * 0.055 },
      leftEyeBottom: { x: cx - rx * 0.40, y: eyeY + ry * 0.05 },

      rightEyeInner: { x: cx + rx * 0.22, y: eyeY + ry * 0.01 },
      rightEyeOuter: { x: cx + rx * 0.58, y: eyeY },
      rightEyeTop: { x: cx + rx * 0.40, y: eyeY - ry * 0.055 },
      rightEyeBottom: { x: cx + rx * 0.40, y: eyeY + ry * 0.05 },

      leftBrowOuter: { x: cx - rx * 0.64, y: browY + ry * 0.02 },
      leftBrowMid: { x: cx - rx * 0.40, y: browY - ry * 0.03 },
      leftBrowInner: { x: cx - rx * 0.18, y: browY + ry * 0.02 },
      rightBrowInner: { x: cx + rx * 0.18, y: browY + ry * 0.02 },
      rightBrowMid: { x: cx + rx * 0.40, y: browY - ry * 0.03 },
      rightBrowOuter: { x: cx + rx * 0.64, y: browY + ry * 0.02 },

      mouthLeft: { x: cx - rx * 0.34, y: mouthY },
      mouthRight: { x: cx + rx * 0.34, y: mouthY },
      upperLipTop: { x: cx, y: mouthY - ry * 0.065 },
      lipCenter: { x: cx, y: mouthY },
      lowerLipBottom: { x: cx, y: mouthY + ry * 0.075 },
    };
  }

  /**
   * MediaPipe Face Landmarker ローダー（シングルトン）
   */
  let mpFaceLandmarkerPromise = null;

  async function getMediaPipeFaceLandmarker() {
    if (mpFaceLandmarkerPromise) return mpFaceLandmarkerPromise;
    mpFaceLandmarkerPromise = (async () => {
      try {
        const visionModule = await import(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs"
        );
        const { FaceLandmarker, FilesetResolver } = visionModule;
        const filesetResolver = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
        );
        const landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "GPU",
          },
          outputFaceBlendshapes: true,
          runningMode: "IMAGE",
          numFaces: 1,
        });
        return landmarker;
      } catch (err) {
        console.warn("MediaPipe CDN読み込み失敗（スマート推定モードを使用します）:", err);
        return null;
      }
    })();
    return mpFaceLandmarkerPromise;
  }

  /**
   * 画像から478点ランドマーク＋主要アンカーを自動検出
   */
  async function detectFaceAnchors(imgElement) {
    try {
      const landmarker = await getMediaPipeFaceLandmarker();
      if (landmarker) {
        const result = landmarker.detect(imgElement);
        if (result && result.faceLandmarks && result.faceLandmarks.length > 0) {
          const lm = result.faceLandmarks[0];
          const pick = (idx) => ({ x: lm[idx].x, y: lm[idx].y, z: lm[idx].z || 0 });
          const upperInner = pick(MP_INDICES.upperLipBottom);
          const lowerInner = pick(MP_INDICES.lowerLipTop);
          const lipCenter = {
            x: (upperInner.x + lowerInner.x) * 0.5,
            y: (upperInner.y + lowerInner.y) * 0.5,
            z: (upperInner.z + lowerInner.z) * 0.5,
          };

          return {
            detectedBy: "mediapipe-478",
            anchors: {
              faceCenter: {
                x: (pick(MP_INDICES.leftCheek).x + pick(MP_INDICES.rightCheek).x) * 0.5,
                y: (pick(MP_INDICES.forehead).y + pick(MP_INDICES.chin).y) * 0.5,
              },
              forehead: pick(MP_INDICES.forehead),
              noseBridge: pick(MP_INDICES.noseBridge),
              noseTip: pick(MP_INDICES.noseTip),
              chin: pick(MP_INDICES.chin),
              leftCheek: pick(MP_INDICES.leftCheek),
              rightCheek: pick(MP_INDICES.rightCheek),
              leftJaw: pick(MP_INDICES.leftJaw),
              rightJaw: pick(MP_INDICES.rightJaw),

              leftEyeOuter: pick(MP_INDICES.leftEyeOuter),
              leftEyeInner: pick(MP_INDICES.leftEyeInner),
              leftEyeTop: pick(MP_INDICES.leftEyeTop),
              leftEyeBottom: pick(MP_INDICES.leftEyeBottom),

              rightEyeInner: pick(MP_INDICES.rightEyeInner),
              rightEyeOuter: pick(MP_INDICES.rightEyeOuter),
              rightEyeTop: pick(MP_INDICES.rightEyeTop),
              rightEyeBottom: pick(MP_INDICES.rightEyeBottom),

              leftBrowOuter: pick(MP_INDICES.leftBrowOuter),
              leftBrowMid: pick(MP_INDICES.leftBrowMid),
              leftBrowInner: pick(MP_INDICES.leftBrowInner),
              rightBrowInner: pick(MP_INDICES.rightBrowInner),
              rightBrowMid: pick(MP_INDICES.rightBrowMid),
              rightBrowOuter: pick(MP_INDICES.rightBrowOuter),

              mouthLeft: pick(MP_INDICES.mouthLeft),
              mouthRight: pick(MP_INDICES.mouthRight),
              upperLipTop: pick(MP_INDICES.upperLipTop),
              lipCenter,
              lowerLipBottom: pick(MP_INDICES.lowerLipBottom),
            },
          };
        }
      }
    } catch (e) {
      console.warn("MediaPipe検出エラー:", e);
    }

    return {
      detectedBy: "smart-estimation",
      anchors: estimateFaceAnchorsFromImage(imgElement),
    };
  }

  /**
   * アンカー群から 2.5D 立体顔メッシュ（頂点リスト＋三角形インデックス）を構築する
   * 上唇内側と下唇内側を別頂点として分離することで、1枚の口閉じ写真でもリアルに口が開閉する
   */
  function buildRiggedFaceMesh(anchors) {
    const a = anchors;
    const vertices = [];

    // 頂点追加ヘルパー: role によってアニメーション時の変形挙動と 3D 深度(z)を定義
    const addV = (x, y, z, role, weight = 1.0) => {
      const idx = vertices.length;
      vertices.push({
        u: Math.max(0, Math.min(1, x)),
        v: Math.max(0, Math.min(1, y)),
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
        z: z, // +z は手前（鼻先など）、-z は奥（耳・背景）
        role,
        weight,
      });
      return idx;
    };

    const lerpPt = (p1, p2, t) => ({
      x: p1.x + (p2.x - p1.x) * t,
      y: p1.y + (p2.y - p1.y) * t,
    });

    // 0..7: キャンバス外周固定枠（背景が破綻しないよう固定）
    const b0 = addV(0.0, 0.0, -0.5, "bg", 0);
    const b1 = addV(0.5, 0.0, -0.5, "bg", 0);
    const b2 = addV(1.0, 0.0, -0.5, "bg", 0);
    const b3 = addV(1.0, 0.5, -0.5, "bg", 0);
    const b4 = addV(1.0, 1.0, -0.5, "bg", 0);
    const b5 = addV(0.5, 1.0, -0.5, "bg", 0);
    const b6 = addV(0.0, 1.0, -0.5, "bg", 0);
    const b7 = addV(0.0, 0.5, -0.5, "bg", 0);

    // 8..15: 頭髪・肩・首の緩衝リング（呼吸と首の揺れに柔らかく追従）
    const headTopY = Math.max(0.04, a.forehead.y - (a.chin.y - a.forehead.y) * 0.36);
    const headLeftX = Math.max(0.05, a.leftCheek.x - 0.14);
    const headRightX = Math.min(0.95, a.rightCheek.x + 0.14);
    const neckY = Math.min(0.95, a.chin.y + 0.15);

    const hTop = addV(a.forehead.x, headTopY, 0.15, "head_outer", 0.55);
    const hTopL = addV((headLeftX + a.forehead.x) * 0.5, headTopY + 0.05, 0.1, "head_outer", 0.55);
    const hTopR = addV((headRightX + a.forehead.x) * 0.5, headTopY + 0.05, 0.1, "head_outer", 0.55);
    const hMidL = addV(headLeftX, a.leftCheek.y, -0.05, "head_outer", 0.5);
    const hMidR = addV(headRightX, a.rightCheek.y, -0.05, "head_outer", 0.5);
    const neckL = addV(a.leftJaw.x - 0.06, neckY, -0.1, "shoulder", 0.4);
    const neckC = addV(a.chin.x, neckY + 0.02, -0.05, "shoulder", 0.45);
    const neckR = addV(a.rightJaw.x + 0.06, neckY, -0.1, "shoulder", 0.4);

    // 顔輪郭・額・頬・顎
    const foreheadC = addV(a.forehead.x, a.forehead.y, 0.45, "head", 0.9);
    const foreheadL = addV(lerpPt(a.forehead, a.leftBrowOuter, 0.55).x, lerpPt(a.forehead, a.leftBrowOuter, 0.35).y, 0.35, "head", 0.85);
    const foreheadR = addV(lerpPt(a.forehead, a.rightBrowOuter, 0.55).x, lerpPt(a.forehead, a.rightBrowOuter, 0.35).y, 0.35, "head", 0.85);

    const cheekOuterL = addV(a.leftCheek.x, a.leftCheek.y, 0.25, "head", 0.85);
    const cheekOuterR = addV(a.rightCheek.x, a.rightCheek.y, 0.25, "head", 0.85);
    const jawL = addV(a.leftJaw.x, a.leftJaw.y, 0.32, "jaw", 0.65);
    const jawR = addV(a.rightJaw.x, a.rightJaw.y, 0.32, "jaw", 0.65);
    const chinC = addV(a.chin.x, a.chin.y, 0.58, "chin", 1.0);
    const chinL = addV((a.chin.x + a.leftJaw.x) * 0.5, (a.chin.y + a.leftJaw.y) * 0.52, 0.46, "chin", 0.82);
    const chinR = addV((a.chin.x + a.rightJaw.x) * 0.5, (a.chin.y + a.rightJaw.y) * 0.52, 0.46, "chin", 0.82);

    // 眉
    const browLO = addV(a.leftBrowOuter.x, a.leftBrowOuter.y, 0.52, "brow_l", 0.8);
    const browLM = addV(a.leftBrowMid.x, a.leftBrowMid.y, 0.60, "brow_l", 1.0);
    const browLI = addV(a.leftBrowInner.x, a.leftBrowInner.y, 0.62, "brow_l", 0.9);
    const browRI = addV(a.rightBrowInner.x, a.rightBrowInner.y, 0.62, "brow_r", 0.9);
    const browRM = addV(a.rightBrowMid.x, a.rightBrowMid.y, 0.60, "brow_r", 1.0);
    const browRO = addV(a.rightBrowOuter.x, a.rightBrowOuter.y, 0.52, "brow_r", 0.8);

    // 左目（上まぶた・下まぶた・目頭・目尻）
    const eyeLO = addV(a.leftEyeOuter.x, a.leftEyeOuter.y, 0.48, "eye_corner_l", 1.0);
    const eyeLI = addV(a.leftEyeInner.x, a.leftEyeInner.y, 0.55, "eye_corner_l", 1.0);
    const eyeLT = addV(a.leftEyeTop.x, a.leftEyeTop.y, 0.58, "eyelid_top_l", 1.0);
    const eyeLB = addV(a.leftEyeBottom.x, a.leftEyeBottom.y, 0.56, "eyelid_bot_l", 1.0);

    // 右目
    const eyeRI = addV(a.rightEyeInner.x, a.rightEyeInner.y, 0.55, "eye_corner_r", 1.0);
    const eyeRO = addV(a.rightEyeOuter.x, a.rightEyeOuter.y, 0.48, "eye_corner_r", 1.0);
    const eyeRT = addV(a.rightEyeTop.x, a.rightEyeTop.y, 0.58, "eyelid_top_r", 1.0);
    const eyeRB = addV(a.rightEyeBottom.x, a.rightEyeBottom.y, 0.56, "eyelid_bot_r", 1.0);

    // 鼻
    const noseBridge = addV(a.noseBridge.x, a.noseBridge.y, 0.72, "nose_bridge", 1.0);
    const noseTip = addV(a.noseTip.x, a.noseTip.y, 0.95, "nose_tip", 1.0);
    const noseWingL = addV(a.noseTip.x - (a.rightEyeInner.x - a.leftEyeInner.x) * 0.36, a.noseTip.y + 0.015, 0.72, "nose_wing", 1.0);
    const noseWingR = addV(a.noseTip.x + (a.rightEyeInner.x - a.leftEyeInner.x) * 0.36, a.noseTip.y + 0.015, 0.72, "nose_wing", 1.0);

    // 内頬（笑うと盛り上がるポイント）
    const cheekInnerL = addV(
      (a.leftEyeOuter.x + a.mouthLeft.x) * 0.48,
      (a.leftEyeBottom.y + a.mouthLeft.y) * 0.52,
      0.62,
      "cheek_l",
      1.0
    );
    const cheekInnerR = addV(
      (a.rightEyeOuter.x + a.mouthRight.x) * 0.52,
      (a.rightEyeBottom.y + a.mouthRight.y) * 0.52,
      0.62,
      "cheek_r",
      1.0
    );

    // 口・唇（重要：上唇内側と下唇内側を分離して口が開くようにする）
    const mouthL = addV(a.mouthLeft.x, a.mouthLeft.y, 0.64, "mouth_corner_l", 1.0);
    const mouthR = addV(a.mouthRight.x, a.mouthRight.y, 0.64, "mouth_corner_r", 1.0);

    const lipTopC = addV(a.upperLipTop.x, a.upperLipTop.y, 0.76, "lip_upper_outer", 1.0);
    const lipTopL = addV(
      (a.mouthLeft.x + a.upperLipTop.x) * 0.5,
      (a.mouthLeft.y + a.upperLipTop.y) * 0.5 - 0.004,
      0.70,
      "lip_upper_outer",
      0.85
    );
    const lipTopR = addV(
      (a.mouthRight.x + a.upperLipTop.x) * 0.5,
      (a.mouthRight.y + a.upperLipTop.y) * 0.5 - 0.004,
      0.70,
      "lip_upper_outer",
      0.85
    );

    // 上唇の内側境界（口が開くときに少し上へ動く）
    const lipInnerUpC = addV(a.lipCenter.x, a.lipCenter.y, 0.74, "lip_upper_inner", 1.0);
    const lipInnerUpL = addV(
      (a.mouthLeft.x + a.lipCenter.x) * 0.5,
      (a.mouthLeft.y + a.lipCenter.y) * 0.5,
      0.68,
      "lip_upper_inner",
      0.75
    );
    const lipInnerUpR = addV(
      (a.mouthRight.x + a.lipCenter.x) * 0.5,
      (a.mouthRight.y + a.lipCenter.y) * 0.5,
      0.68,
      "lip_upper_inner",
      0.75
    );

    // 下唇の内側境界（口が開くときに顎と一緒に下へ大きく動く！）
    const lipInnerLowC = addV(a.lipCenter.x, a.lipCenter.y, 0.74, "lip_lower_inner", 1.0);
    const lipInnerLowL = addV(
      (a.mouthLeft.x + a.lipCenter.x) * 0.5,
      (a.mouthLeft.y + a.lipCenter.y) * 0.5,
      0.68,
      "lip_lower_inner",
      0.75
    );
    const lipInnerLowR = addV(
      (a.mouthRight.x + a.lipCenter.x) * 0.5,
      (a.mouthRight.y + a.lipCenter.y) * 0.5,
      0.68,
      "lip_lower_inner",
      0.75
    );

    // 下唇の外側境界
    const lipBotC = addV(a.lowerLipBottom.x, a.lowerLipBottom.y, 0.74, "lip_lower_outer", 1.0);
    const lipBotL = addV(
      (a.mouthLeft.x + a.lowerLipBottom.x) * 0.5,
      (a.mouthLeft.y + a.lowerLipBottom.y) * 0.5 + 0.004,
      0.68,
      "lip_lower_outer",
      0.85
    );
    const lipBotR = addV(
      (a.mouthRight.x + a.lowerLipBottom.x) * 0.5,
      (a.mouthRight.y + a.lowerLipBottom.y) * 0.5 + 0.004,
      0.68,
      "lip_lower_outer",
      0.85
    );

    // 三角形メッシュ接続定義（反時計回り・隙間なし）
    const triangles = [
      // 背景外周〜頭部外周
      [b0, b1, hTopL], [b1, hTop, hTopL], [b1, b2, hTopR], [b1, hTopR, hTop],
      [b0, hTopL, b7], [b7, hTopL, hMidL], [b7, hMidL, b6], [b6, hMidL, neckL],
      [b2, b3, hTopR], [b3, hMidR, hTopR], [b3, b4, hMidR], [b4, neckR, hMidR],
      [b6, neckL, b5], [b5, neckL, neckC], [b5, neckC, neckR], [b5, neckR, b4],

      // 頭部外周〜額・頬・顎・首
      [hTopL, hTop, foreheadL], [hTop, foreheadC, foreheadL],
      [hTop, hTopR, foreheadR], [hTop, foreheadR, foreheadC],
      [hTopL, foreheadL, hMidL], [hMidL, foreheadL, browLO], [hMidL, browLO, cheekOuterL],
      [hTopR, hMidR, foreheadR], [hMidR, browRO, foreheadR], [hMidR, cheekOuterR, browRO],
      [hMidL, cheekOuterL, jawL], [hMidL, jawL, neckL],
      [hMidR, jawR, cheekOuterR], [hMidR, neckR, jawR],
      [neckL, jawL, chinL], [neckL, chinL, neckC], [neckC, chinL, chinC],
      [neckC, chinC, chinR], [neckC, chinR, neckR], [neckR, chinR, jawR],

      // 額〜眉
      [foreheadL, foreheadC, browLM], [foreheadL, browLM, browLO],
      [foreheadC, browLI, browLM], [foreheadC, browRI, browLI],
      [foreheadC, browRM, browRI], [foreheadC, foreheadR, browRM], [foreheadR, browRO, browRM],
      [browLI, browRI, noseBridge],

      // 左眉〜左目
      [browLO, browLM, eyeLO], [browLM, eyeLT, eyeLO],
      [browLM, browLI, eyeLT], [browLI, eyeLI, eyeLT],
      [browLI, noseBridge, eyeLI],

      // 右眉〜右目
      [browRI, eyeRI, noseBridge], [browRI, eyeRT, eyeRI],
      [browRI, browRM, eyeRT], [browRM, eyeRO, eyeRT],
      [browRM, browRO, eyeRO],

      // 左目内部（まばたき時に eyeLT が eyeLB に近づく）
      [eyeLO, eyeLT, eyeLB], [eyeLT, eyeLI, eyeLB],

      // 右目内部
      [eyeRI, eyeRT, eyeRB], [eyeRT, eyeRO, eyeRB],

      // 目〜頬〜鼻
      [cheekOuterL, browLO, eyeLO], [cheekOuterL, eyeLO, cheekInnerL],
      [eyeLO, eyeLB, cheekInnerL], [eyeLB, eyeLI, noseWingL], [eyeLB, noseWingL, cheekInnerL],
      [eyeLI, noseBridge, noseTip], [eyeLI, noseTip, noseWingL],

      [cheekOuterR, eyeRO, browRO], [cheekOuterR, cheekInnerR, eyeRO],
      [eyeRO, cheekInnerR, eyeRB], [eyeRB, noseWingR, eyeRI], [eyeRB, cheekInnerR, noseWingR],
      [eyeRI, noseTip, noseBridge], [eyeRI, noseWingR, noseTip],

      // 頬〜口周り〜鼻下
      [cheekOuterL, cheekInnerL, jawL], [jawL, cheekInnerL, mouthL],
      [cheekInnerL, noseWingL, mouthL],
      [noseWingL, noseTip, lipTopL], [noseWingL, lipTopL, mouthL],
      [noseTip, lipTopC, lipTopL], [noseTip, lipTopR, lipTopC],
      [noseTip, noseWingR, lipTopR], [noseWingR, mouthR, lipTopR],
      [cheekInnerR, mouthR, noseWingR],
      [cheekOuterR, jawR, cheekInnerR], [jawR, mouthR, cheekInnerR],

      // 上唇メッシュ（外縁〜内縁）
      [mouthL, lipTopL, lipInnerUpL],
      [lipTopL, lipTopC, lipInnerUpL],
      [lipTopC, lipInnerUpC, lipInnerUpL],
      [lipTopC, lipTopR, lipInnerUpC],
      [lipTopR, lipInnerUpR, lipInnerUpC],
      [lipTopR, mouthR, lipInnerUpR],

      // 下唇メッシュ（内縁〜外縁）
      [mouthL, lipInnerLowL, lipBotL],
      [lipInnerLowL, lipInnerLowC, lipBotL],
      [lipInnerLowC, lipBotC, lipBotL],
      [lipInnerLowC, lipInnerLowR, lipBotC],
      [lipInnerLowR, lipBotR, lipBotC],
      [lipInnerLowR, mouthR, lipBotR],

      // 下唇〜顎・フェイスライン
      [jawL, mouthL, chinL], [mouthL, lipBotL, chinL],
      [lipBotL, lipBotC, chinL], [lipBotC, chinC, chinL],
      [lipBotC, chinR, chinC], [lipBotC, lipBotR, chinR],
      [lipBotR, mouthR, chinR], [mouthR, jawR, chinR],
    ];

    return {
      vertices,
      triangles,
      mouthCavityRing: {
        left: mouthL,
        upperL: lipInnerUpL,
        upperC: lipInnerUpC,
        upperR: lipInnerUpR,
        right: mouthR,
        lowerR: lipInnerLowR,
        lowerC: lipInnerLowC,
        lowerL: lipInnerLowL,
      },
      eyeRings: {
        left: { outer: eyeLO, top: eyeLT, inner: eyeLI, bottom: eyeLB },
        right: { inner: eyeRI, top: eyeRT, outer: eyeRO, bottom: eyeRB },
      },
      contourRing: {
        hTop,
        hTopL,
        hTopR,
        hMidL,
        hMidR,
        foreheadL,
        foreheadC,
        foreheadR,
        cheekOuterL,
        cheekOuterR,
        jawL,
        jawR,
        chinL,
        chinC,
        chinR,
      },
      cheekIndices: {
        left: cheekInnerL,
        right: cheekInnerR,
      },
    };
  }

  /**
   * リアルな初期デモポートレートを生成（ユーザーが写真を登録する前でも動作確認可能）
   */
  
  /* ==========================================================================
   * Mirai Complete New Avatar Engine (写真のピクセルを一切貼らず、0から新規描画する完全アバター生成)
   * - 写真の478点ランドマーク比率・色彩・生え際シルエット＋Gemini Vision AI解析データ (avatarSpec) を基に、
   *   写真の人物の特徴（輪郭・目つき・眉・鼻・口・髪型・前髪・メガネ・ヒゲ等）を忠実に捉えた
   *   「首から上だけ」の 2.5D デジタルアバター（アルターエゴ風）を 100% 新規ベクター描画する
   * ========================================================================== */

  function enrichAnchors(rawAnchors) {
    const base = createDefaultAnchors();
    const A = Object.assign({}, base, rawAnchors || {});
    A.leftEye = {
      x: ((A.leftEyeOuter ? A.leftEyeOuter.x : 0.34) + (A.leftEyeInner ? A.leftEyeInner.x : 0.44)) * 0.5,
      y: ((A.leftEyeTop ? A.leftEyeTop.y : 0.382) + (A.leftEyeBottom ? A.leftEyeBottom.y : 0.418)) * 0.5,
    };
    A.rightEye = {
      x: ((A.rightEyeInner ? A.rightEyeInner.x : 0.56) + (A.rightEyeOuter ? A.rightEyeOuter.x : 0.66)) * 0.5,
      y: ((A.rightEyeTop ? A.rightEyeTop.y : 0.382) + (A.rightEyeBottom ? A.rightEyeBottom.y : 0.418)) * 0.5,
    };
    return A;
  }

  function sampleAverageRgb(ctx, cx, cy, radius = 6) {
    try {
      const x0 = Math.max(0, Math.floor(cx - radius));
      const y0 = Math.max(0, Math.floor(cy - radius));
      const w = Math.min(ctx.canvas.width - x0, radius * 2);
      const h = Math.min(ctx.canvas.height - y0, radius * 2);
      if (w <= 0 || h <= 0) return { r: 235, g: 195, b: 175 };
      const imgData = ctx.getImageData(x0, y0, w, h);
      const data = imgData.data;
      let r = 0, g = 0, b = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count++;
      }
      return count > 0
        ? { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) }
        : { r: 235, g: 195, b: 175 };
    } catch (_) {
      return { r: 235, g: 195, b: 175 };
    }
  }

  function rgbToHex(r, g, b) {
    return (
      "#" +
      [r, g, b]
        .map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0"))
        .join("")
    );
  }

  function hexToRgb(hex, fallback = { r: 235, g: 195, b: 175 }) {
    if (!hex || typeof hex !== "string") return fallback;
    const m = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex.trim());
    if (!m) return fallback;
    return {
      r: parseInt(m[1], 16),
      g: parseInt(m[2], 16),
      b: parseInt(m[3], 16),
    };
  }

  function clampSkinPalette(rawSkin) {
    const lum = rawSkin.r * 0.299 + rawSkin.g * 0.587 + rawSkin.b * 0.114;
    const boost = lum < 150 ? Math.min(1.4, 175 / Math.max(60, lum)) : lum > 240 ? 0.95 : 1.05;
    const r = Math.min(252, Math.max(198, Math.round(rawSkin.r * boost + 6)));
    const g = Math.min(232, Math.max(160, Math.round(rawSkin.g * boost + 3)));
    const b = Math.min(216, Math.max(140, Math.round(rawSkin.b * boost + 2)));
    return {
      r,
      g,
      b,
      baseHex: rgbToHex(r, g, b),
      lightHex: rgbToHex(Math.min(255, r + 15), Math.min(255, g + 13), Math.min(255, b + 12)),
      shadowHex: rgbToHex(Math.round(r * 0.84), Math.round(g * 0.78), Math.round(b * 0.77)),
      deepShadowHex: rgbToHex(Math.round(r * 0.68), Math.round(g * 0.60), Math.round(b * 0.60)),
    };
  }

  function clampHairPalette(rawHair) {
    const r = Math.min(200, Math.max(18, rawHair.r));
    const g = Math.min(190, Math.max(16, rawHair.g));
    const b = Math.min(210, Math.max(22, rawHair.b));
    return {
      r,
      g,
      b,
      baseHex: rgbToHex(r, g, b),
      darkHex: rgbToHex(Math.round(r * 0.62), Math.round(g * 0.62), Math.round(b * 0.68)),
      lightHex: rgbToHex(Math.min(255, r + 45), Math.min(255, g + 42), Math.min(255, b + 52)),
    };
  }

  /**
   * 写真と478点ランドマークから、本人の顔パーツ比率・髪型シルエット・メガネ有無・色彩を解析し、
   * 新規アバター描画用の設計データ (avatarSpec) を生成する
   */
  function analyzePhotoToAvatarSpec(sourceImage, rawAnchors, aiSpecOverride = null) {
    const A = enrichAnchors(rawAnchors);
    const size = 256;
    const off = document.createElement("canvas");
    off.width = size;
    off.height = size;
    const ctx = off.getContext("2d", { willReadFrequently: true });
    if (sourceImage) {
      ctx.drawImage(sourceImage, 0, 0, size, size);
    }

    // 1. 肌色・髪色・瞳色・唇色の抽出
    const sNose = sampleAverageRgb(ctx, A.noseBridge.x * size, A.noseBridge.y * size, 5);
    const sCheekL = sampleAverageRgb(ctx, (A.leftCheek.x * 0.6 + A.noseTip.x * 0.4) * size, A.leftCheek.y * size, 6);
    const sCheekR = sampleAverageRgb(ctx, (A.rightCheek.x * 0.6 + A.noseTip.x * 0.4) * size, A.rightCheek.y * size, 6);
    const rawSkin = {
      r: Math.round((sNose.r + sCheekL.r + sCheekR.r) / 3),
      g: Math.round((sNose.g + sCheekL.g + sCheekR.g) / 3),
      b: Math.round((sNose.b + sCheekL.b + sCheekR.b) / 3),
    };

    const faceH = Math.max(0.24, A.chin.y - A.forehead.y);
    const faceW = Math.max(0.24, A.rightCheek.x - A.leftCheek.x);
    const hairTopY = Math.max(6, (A.forehead.y - faceH * 0.28) * size);
    const rawHairTop = sampleAverageRgb(ctx, A.forehead.x * size, hairTopY, 8);
    const rawHairL = sampleAverageRgb(ctx, Math.max(8, (A.leftCheek.x - faceW * 0.08) * size), A.forehead.y * size, 7);
    const rawHair = {
      r: Math.round((rawHairTop.r + rawHairL.r) * 0.5),
      g: Math.round((rawHairTop.g + rawHairL.g) * 0.5),
      b: Math.round((rawHairTop.b + rawHairL.b) * 0.5),
    };

    const rawIris = sampleAverageRgb(ctx, A.leftEye.x * size, A.leftEye.y * size, 2);
    const rawLip = sampleAverageRgb(ctx, A.lipCenter.x * size, A.lowerLipBottom.y * size, 4);

    // 2. 額の肌色露出度から「前髪の分け目・スタイル」を自動判定
    const fY = (A.forehead.y + (A.leftBrowMid.y + A.rightBrowMid.y) * 0.25) / 1.25 * size;
    const cols = [-0.28, -0.14, 0, 0.14, 0.28].map((ox) => {
      const c = sampleAverageRgb(ctx, (A.forehead.x + ox * faceW) * size, fY, 4);
      const diffSkin = Math.abs(c.r - rawSkin.r) + Math.abs(c.g - rawSkin.g) + Math.abs(c.b - rawSkin.b);
      return diffSkin < 65; // true = 額の肌が見えている, false = 前髪で覆われている
    });

    let detectedBangs = "parted_right";
    const openCount = cols.filter(Boolean).length;
    if (openCount >= 4) {
      detectedBangs = "forehead_open";
    } else if (openCount === 0) {
      detectedBangs = "full_down";
    } else if (cols[2] && !cols[0] && !cols[4]) {
      detectedBangs = "parted_center";
    } else if (cols[1] && !cols[3]) {
      detectedBangs = "parted_left";
    } else {
      detectedBangs = "parted_right";
    }

    // 3. 顔の下横（エラの外側）の暗さから髪の長さ（ショート vs ミディアム/ロング）を判定
    const sideLowL = sampleAverageRgb(ctx, Math.max(6, (A.leftJaw.x - faceW * 0.16) * size), A.leftJaw.y * size, 6);
    const sideLowR = sampleAverageRgb(ctx, Math.min(size - 6, (A.rightJaw.x + faceW * 0.16) * size), A.rightJaw.y * size, 6);
    const hairDiffL = Math.abs(sideLowL.r - rawHair.r) + Math.abs(sideLowL.g - rawHair.g) + Math.abs(sideLowL.b - rawHair.b);
    const hairDiffR = Math.abs(sideLowR.r - rawHair.r) + Math.abs(sideLowR.g - rawHair.g) + Math.abs(sideLowR.b - rawHair.b);
    const hasLongSideHair = hairDiffL < 55 && hairDiffR < 55;

    // 4. ランドマークから本人固有の骨格・目鼻立ち比率を算出
    const jawSpan = A.rightJaw.x - A.leftJaw.x;
    const jawTaper = Math.max(0.72, Math.min(1.25, (jawSpan / faceW) * 1.32));

    const lEyeW = Math.hypot(A.leftEyeInner.x - A.leftEyeOuter.x, A.leftEyeInner.y - A.leftEyeOuter.y);
    const lEyeH = Math.abs(A.leftEyeBottom.y - A.leftEyeTop.y);
    const eyeOpenAspect = lEyeH / Math.max(0.02, lEyeW);
    const eyeSize = Math.max(0.82, Math.min(1.25, (lEyeW / faceW) * 4.4));

    // つり目・たれ目角度（目頭に対する目尻の高さ）
    const lSlant = (A.leftEyeInner.y - A.leftEyeOuter.y) / Math.max(0.02, lEyeW);
    const rSlant = (A.rightEyeInner.y - A.rightEyeOuter.y) / Math.max(0.02, lEyeW);
    const eyeSlant = Math.max(-0.28, Math.min(0.28, (lSlant + rSlant) * 0.5));

    // 眉の角度
    const browSlope = (A.leftBrowOuter.y - A.leftBrowInner.y) / Math.max(0.03, A.leftBrowInner.x - A.leftBrowOuter.x);
    const eyebrowTilt = Math.max(-0.25, Math.min(0.25, -browSlope * 0.6));

    // 鼻筋ブリッジ上の強いコントラストからメガネの有無を簡易判定
    const bridgeMid = sampleAverageRgb(ctx, A.noseBridge.x * size, A.noseBridge.y * size, 2);
    const bridgeDiff = Math.abs(bridgeMid.r - rawSkin.r) + Math.abs(bridgeMid.g - rawSkin.g) + Math.abs(bridgeMid.b - rawSkin.b);
    const detectedGlasses = bridgeDiff > 95 ? "square" : "none";

    const skinPal = clampSkinPalette(
      aiSpecOverride && aiSpecOverride.skin_hex ? hexToRgb(aiSpecOverride.skin_hex, rawSkin) : rawSkin
    );
    const hairPal = clampHairPalette(
      aiSpecOverride && aiSpecOverride.hair_hex ? hexToRgb(aiSpecOverride.hair_hex, rawHair) : rawHair
    );

    const irisRgb = aiSpecOverride && aiSpecOverride.iris_hex
      ? hexToRgb(aiSpecOverride.iris_hex, rawIris)
      : {
          r: Math.min(160, Math.max(28, rawIris.r)),
          g: Math.min(140, Math.max(22, rawIris.g)),
          b: Math.min(150, Math.max(20, rawIris.b)),
        };

    const spec = {
      gender_vibe: "neutral",
      face_shape: jawTaper < 0.88 ? "sharp" : jawTaper > 1.08 ? "square" : "oval",
      jaw_taper: jawTaper,
      skin: skinPal,
      hair: hairPal,
      hair_style: hasLongSideHair ? "medium_parted" : "short_neat",
      bangs_style: detectedBangs,
      hair_volume: 1.0,
      eyebrow_style: "straight",
      eyebrow_thickness: 1.0,
      eyebrow_tilt: eyebrowTilt,
      eye_shape: eyeOpenAspect > 0.42 ? "round" : eyeOpenAspect < 0.28 ? "narrow" : "almond",
      eye_size: eyeSize,
      eye_slant: eyeSlant,
      double_eyelid: true,
      eye_bags: true,
      iris_hex: rgbToHex(irisRgb.r, irisRgb.g, irisRgb.b),
      iris_light_hex: rgbToHex(Math.min(255, irisRgb.r + 55), Math.min(255, irisRgb.g + 48), Math.min(255, irisRgb.b + 45)),
      nose_style: "straight",
      mouth_width_scale: Math.max(0.82, Math.min(1.22, ((A.mouthRight.x - A.mouthLeft.x) / faceW) * 2.5)),
      lip_thickness: 1.0,
      lip_hex: rgbToHex(
        Math.min(225, Math.max(165, rawLip.r)),
        Math.min(145, Math.max(95, rawLip.g)),
        Math.min(145, Math.max(95, rawLip.b))
      ),
      glasses: detectedGlasses,
      glasses_hex: "#1c1e28",
      facial_hair: "none",
      mole: "none",
    };

    if (aiSpecOverride && typeof aiSpecOverride === "object") {
      Object.assign(spec, aiSpecOverride);
      spec.skin = clampSkinPalette(aiSpecOverride.skin_hex ? hexToRgb(aiSpecOverride.skin_hex, rawSkin) : rawSkin);
      spec.hair = clampHairPalette(aiSpecOverride.hair_hex ? hexToRgb(aiSpecOverride.hair_hex, rawHair) : rawHair);
      if (aiSpecOverride.iris_hex) {
        const ir = hexToRgb(aiSpecOverride.iris_hex, irisRgb);
        spec.iris_hex = rgbToHex(ir.r, ir.g, ir.b);
        spec.iris_light_hex = rgbToHex(Math.min(255, ir.r + 55), Math.min(255, ir.g + 48), Math.min(255, ir.b + 45));
      }
    }

    return spec;
  }

  /**
   * 設計データ (avatarSpec) とランドマーク比率から、写真のピクセルを一切使わずに
   * 「首から上だけ」の完全新規 2.5D デジタルアバター（アルターエゴ風）を指定状態の Canvas に描画するコア関数
   */
  function renderNewlyCreatedAvatarFrame(ctx, S, A, spec, state, settings) {
    const s = state || {
      mouthOpen: 0,
      mouthSpread: 0,
      smileWeight: 0.12,
      blinkLeft: 0,
      blinkRight: 0,
      browLift: 0,
      headYaw: 0,
      headPitch: 0,
      headRoll: 0,
      breath: 0,
      lookX: 0,
      lookY: 0,
      mode: "idle",
    };
    const cfg = settings || {
      headMotionScale: 1.0,
      depthScale: 1.0,
      vtuberCheek: 1.0,
      vtuberEyeShine: 1.1,
    };

    const holoIntensity = cfg.vtuberCheek !== undefined ? cfg.vtuberCheek : 1.0;
    const shineScale = cfg.vtuberEyeShine !== undefined ? cfg.vtuberEyeShine : 1.1;
    const now = performance.now();

    // =========================================================
    // 1. ダンガンロンパ「アルターエゴ」風 デジタルモニター背景
    // =========================================================
    const bgGrad = ctx.createRadialGradient(S * 0.5, S * 0.45, S * 0.04, S * 0.5, S * 0.5, S * 0.72);
    bgGrad.addColorStop(0, "#10283b");
    bgGrad.addColorStop(0.55, "#071522");
    bgGrad.addColorStop(1, "#02060c");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, S, S);

    if (holoIntensity > 0.05) {
      ctx.save();
      const gridAlpha = Math.min(0.24, 0.08 * holoIntensity);
      ctx.strokeStyle = `rgba(56, 189, 248, ${gridAlpha})`;
      ctx.lineWidth = 1;
      const step = S / 12;
      for (let i = 1; i < 12; i++) {
        ctx.beginPath();
        ctx.moveTo(0, i * step);
        ctx.lineTo(S, i * step);
        ctx.moveTo(i * step, 0);
        ctx.lineTo(i * step, S);
        ctx.stroke();
      }

      const voiceBoost = s.mode === "speaking" ? s.mouthOpen * 0.25 : 0;
      const glowR = S * (0.34 + Math.sin(now * 0.0025) * 0.015 + voiceBoost);
      const holoGlow = ctx.createRadialGradient(S * 0.5, S * 0.46, S * 0.05, S * 0.5, S * 0.46, glowR);
      holoGlow.addColorStop(0, `rgba(34, 211, 238, ${Math.min(0.38, (0.16 + voiceBoost) * holoIntensity)})`);
      holoGlow.addColorStop(0.6, `rgba(16, 185, 129, ${Math.min(0.18, 0.07 * holoIntensity)})`);
      holoGlow.addColorStop(1, "rgba(16, 185, 129, 0)");
      ctx.fillStyle = holoGlow;
      ctx.fillRect(0, 0, S, S);
      ctx.restore();
    }

    // =========================================================
    // 2. 本人のランドマーク比率を基準とした 2.5D 頭部座標系
    // =========================================================
    const rawFaceW = Math.max(0.32, Math.min(0.54, A.rightCheek.x - A.leftCheek.x));
    const rawFaceH = Math.max(0.38, Math.min(0.60, A.chin.y - A.forehead.y));

    // アバターとしての見栄えが最も整う中心スケールへ正規化しつつ、本人の縦横比（丸顔・面長等）を忠実に維持
    const aspect = rawFaceH / rawFaceW;
    const faceW = S * 0.44;
    const faceH = faceW * Math.max(1.02, Math.min(1.36, aspect * 0.96));

    const yaw = s.headYaw * cfg.headMotionScale * cfg.depthScale;
    const pitch = s.headPitch * cfg.headMotionScale * cfg.depthScale;
    const roll = s.headRoll * 0.055 * cfg.headMotionScale;
    const floatY = -Math.sin(s.breath * Math.PI) * S * 0.008;

    const headCx = S * 0.5 + yaw * S * 0.025;
    const headCy = S * 0.47 + pitch * S * 0.02 + floatY;

    // パーツの奥行きに応じたパララックスシフト関数 (z: 0=頭部中心, +1=鼻先・顔前面, -1=後頭部)
    const px = (localX, z = 0) => headCx + localX + yaw * z * faceW * 0.085;
    const py = (localY, z = 0) => headCy + localY + pitch * z * faceH * 0.075;

    ctx.save();
    ctx.translate(headCx, headCy);
    ctx.rotate(roll);
    ctx.translate(-headCx, -headCy);

    const foreheadY = -faceH * 0.46;
    const cheekY = +faceH * 0.04;
    const jawY = +faceH * 0.28;
    const chinY = +faceH * 0.50 + s.mouthOpen * faceH * 0.035;
    const jawTaper = spec.jaw_taper || 1.0;
    const halfW = faceW * 0.5;
    const jawHalfW = halfW * 0.76 * jawTaper;

    const skin = spec.skin || clampSkinPalette({ r: 238, g: 198, b: 176 });
    const hair = spec.hair || clampHairPalette({ r: 28, g: 28, b: 38 });
    const hairStyle = spec.hair_style || "short_neat";
    const bangsStyle = spec.bangs_style || "parted_right";
    const hairVol = spec.hair_volume || 1.0;

    // =========================================================
    // 3. 後ろ髪（Back Hair：髪型に応じて新規描画）
    // =========================================================
    ctx.save();
    const backHairGrad = ctx.createLinearGradient(headCx, py(foreheadY - faceH * 0.25), headCx, py(chinY + faceH * 0.35));
    backHairGrad.addColorStop(0, hair.baseHex);
    backHairGrad.addColorStop(1, hair.darkHex);
    ctx.fillStyle = backHairGrad;
    ctx.strokeStyle = "#12131c";
    ctx.lineWidth = Math.max(2.0, S * 0.0034);

    const isLongHair = hairStyle === "long_straight" || hairStyle === "long_wavy" || hairStyle === "bob" || hairStyle === "medium_parted";
    const backBottomY = hairStyle.startsWith("long")
      ? chinY + faceH * 0.34
      : hairStyle === "bob" || hairStyle === "medium_parted"
      ? chinY + faceH * 0.12
      : jawY + faceH * 0.04;
    const backSpreadW = isLongHair ? halfW * 1.18 * hairVol : halfW * 1.08 * hairVol;

    ctx.beginPath();
    ctx.moveTo(px(0, -0.5), py(foreheadY - faceH * 0.22 * hairVol, -0.5));
    ctx.bezierCurveTo(
      px(-backSpreadW * 1.05, -0.5),
      py(foreheadY - faceH * 0.12, -0.5),
      px(-backSpreadW * 1.08, -0.5),
      py(cheekY, -0.5),
      px(-backSpreadW * 0.92, -0.5),
      py(backBottomY, -0.5)
    );
    ctx.quadraticCurveTo(px(0, -0.5), py(backBottomY + faceH * 0.05, -0.5), px(backSpreadW * 0.92, -0.5), py(backBottomY, -0.5));
    ctx.bezierCurveTo(
      px(backSpreadW * 1.08, -0.5),
      py(cheekY, -0.5),
      px(backSpreadW * 1.05, -0.5),
      py(foreheadY - faceH * 0.12, -0.5),
      px(0, -0.5),
      py(foreheadY - faceH * 0.22 * hairVol, -0.5)
    );
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // =========================================================
    // 4. 首から上だけの首元（Upper Neck：下端はモニター空間へ綺麗にフェード）
    // =========================================================
    ctx.save();
    const neckW = halfW * 0.62;
    const neckTopY = jawY + faceH * 0.08;
    const neckBotY = chinY + faceH * 0.24;

    const neckGrad = ctx.createLinearGradient(headCx, py(neckTopY, -0.2), headCx, py(neckBotY, -0.2));
    neckGrad.addColorStop(0, skin.deepShadowHex);
    neckGrad.addColorStop(0.28, skin.shadowHex);
    neckGrad.addColorStop(0.68, skin.baseHex);
    neckGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = neckGrad;
    ctx.beginPath();
    ctx.moveTo(px(-neckW * 0.5, -0.2), py(neckTopY, -0.2));
    ctx.quadraticCurveTo(px(-neckW * 0.48, -0.2), py((neckTopY + neckBotY) * 0.5, -0.2), px(-neckW * 0.56, -0.2), py(neckBotY, -0.2));
    ctx.lineTo(px(neckW * 0.56, -0.2), py(neckBotY, -0.2));
    ctx.quadraticCurveTo(px(neckW * 0.48, -0.2), py((neckTopY + neckBotY) * 0.5, -0.2), px(neckW * 0.5, -0.2), py(neckTopY, -0.2));
    ctx.closePath();
    ctx.fill();

    // 首の左右ライン（上部のみ）
    ctx.strokeStyle = "rgba(42, 26, 30, 0.65)";
    ctx.lineWidth = Math.max(1.8, S * 0.003);
    ctx.beginPath();
    ctx.moveTo(px(-neckW * 0.49, -0.2), py(chinY - faceH * 0.04, -0.2));
    ctx.lineTo(px(-neckW * 0.52, -0.2), py(chinY + faceH * 0.14, -0.2));
    ctx.moveTo(px(neckW * 0.49, -0.2), py(chinY - faceH * 0.04, -0.2));
    ctx.lineTo(px(neckW * 0.52, -0.2), py(chinY + faceH * 0.14, -0.2));
    ctx.stroke();
    ctx.restore();

    // =========================================================
    // 5. 両耳（Ears）
    // =========================================================
    const earW = faceW * 0.075;
    const earH = faceH * 0.14;
    for (const sign of [-1, 1]) {
      ctx.save();
      const ex = px(sign * (halfW * 0.98), -0.15);
      const ey = py(cheekY - faceH * 0.02, -0.15);
      ctx.fillStyle = skin.baseHex;
      ctx.strokeStyle = "#2b1c20";
      ctx.lineWidth = Math.max(2.0, S * 0.0032);
      ctx.beginPath();
      ctx.ellipse(ex, ey, earW, earH, sign * 0.12, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = skin.shadowHex;
      ctx.beginPath();
      ctx.ellipse(ex - sign * earW * 0.15, ey + 1, earW * 0.48, earH * 0.55, sign * 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // =========================================================
    // 6. 顔輪郭（Face Contour：本人のエラ幅・顎形状・縦横比で新規描画）
    // =========================================================
    ctx.save();
    const faceGrad = ctx.createRadialGradient(
      px(0, 0.5),
      py(-faceH * 0.06, 0.5),
      faceW * 0.06,
      px(0, 0.2),
      py(0, 0.2),
      faceH * 0.65
    );
    faceGrad.addColorStop(0, skin.lightHex);
    faceGrad.addColorStop(0.58, skin.baseHex);
    faceGrad.addColorStop(1, skin.shadowHex);

    ctx.fillStyle = faceGrad;
    ctx.strokeStyle = "#26181c";
    ctx.lineWidth = Math.max(2.3, S * 0.0038);
    ctx.lineJoin = "round";

    ctx.beginPath();
    ctx.moveTo(px(0, 0.2), py(foreheadY - faceH * 0.06, 0.2));
    // 左こめかみ〜左頬
    ctx.bezierCurveTo(
      px(-halfW * 0.92, 0.2),
      py(foreheadY - faceH * 0.04, 0.2),
      px(-halfW * 1.02, 0.25),
      py(-faceH * 0.15, 0.25),
      px(-halfW, 0.3),
      py(cheekY, 0.3)
    );
    // 左頬〜左エラ
    ctx.quadraticCurveTo(
      px(-halfW * 0.96, 0.3),
      py((cheekY + jawY) * 0.52, 0.3),
      px(-jawHalfW, 0.35),
      py(jawY, 0.35)
    );
    // 左エラ〜顎先
    ctx.quadraticCurveTo(
      px(-jawHalfW * 0.52, 0.45),
      py(chinY - faceH * 0.02, 0.45),
      px(0, 0.55),
      py(chinY, 0.55)
    );
    // 顎先〜右エラ
    ctx.quadraticCurveTo(
      px(jawHalfW * 0.52, 0.45),
      py(chinY - faceH * 0.02, 0.45),
      px(jawHalfW, 0.35),
      py(jawY, 0.35)
    );
    // 右エラ〜右頬
    ctx.quadraticCurveTo(
      px(halfW * 0.96, 0.3),
      py((cheekY + jawY) * 0.52, 0.3),
      px(halfW, 0.3),
      py(cheekY, 0.3)
    );
    // 右頬〜右こめかみ〜額
    ctx.bezierCurveTo(
      px(halfW * 1.02, 0.25),
      py(-faceH * 0.15, 0.25),
      px(halfW * 0.92, 0.2),
      py(foreheadY - faceH * 0.04, 0.2),
      px(0, 0.2),
      py(foreheadY - faceH * 0.06, 0.2)
    );
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 頬の自然な立体血色シェード
    for (const sign of [-1, 1]) {
      const chX = px(sign * halfW * 0.56, 0.55);
      const chY = py(cheekY + faceH * 0.02, 0.55);
      const chG = ctx.createRadialGradient(chX, chY, 2, chX, chY, faceW * 0.16);
      chG.addColorStop(0, "rgba(232, 130, 122, 0.18)");
      chG.addColorStop(1, "rgba(232, 130, 122, 0)");
      ctx.fillStyle = chG;
      ctx.beginPath();
      ctx.arc(chX, chY, faceW * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }

    // ヒゲ・ホクロがある場合の描画
    if (spec.facial_hair && spec.facial_hair !== "none") {
      ctx.fillStyle = "rgba(40, 35, 42, 0.26)";
      if (spec.facial_hair === "beard" || spec.facial_hair === "goatee" || spec.facial_hair === "stubble") {
        ctx.beginPath();
        ctx.ellipse(px(0, 0.55), py(chinY - faceH * 0.04, 0.55), jawHalfW * 0.42, faceH * 0.06, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      if (spec.facial_hair === "mustache" || spec.facial_hair === "beard" || spec.facial_hair === "stubble") {
        ctx.beginPath();
        ctx.ellipse(px(0, 0.65), py(faceH * 0.19, 0.65), faceW * 0.14, faceH * 0.022, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // =========================================================
    // 7. 鼻（Nose：2.5D パララックス立体陰影）
    // =========================================================
    ctx.save();
    const noseBridgeX = px(0, 0.72);
    const noseBridgeY = py(-faceH * 0.11, 0.72);
    const noseTipX = px(yaw * faceW * 0.03, 0.98);
    const noseTipY = py(faceH * 0.06, 0.98);

    // 鼻筋のセル影
    ctx.fillStyle = skin.shadowHex;
    ctx.beginPath();
    ctx.moveTo(noseBridgeX - 2, noseBridgeY);
    ctx.lineTo(noseTipX - faceW * 0.032, noseTipY);
    ctx.lineTo(noseTipX, noseTipY + faceH * 0.028);
    ctx.lineTo(noseTipX + 2, noseTipY);
    ctx.closePath();
    ctx.fill();

    // 鼻筋ライン
    ctx.strokeStyle = "rgba(75, 44, 42, 0.58)";
    ctx.lineWidth = Math.max(1.8, S * 0.0028);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(noseBridgeX - 1.5, noseBridgeY + faceH * 0.02);
    ctx.lineTo(noseTipX - faceW * 0.018, noseTipY);
    ctx.lineTo(noseTipX + faceW * 0.008, noseTipY + faceH * 0.015);
    ctx.stroke();

    // 鼻先ハイライト
    ctx.fillStyle = "rgba(255, 250, 246, 0.55)";
    ctx.beginPath();
    ctx.ellipse(noseTipX + 1, noseTipY - 2, faceW * 0.016, faceH * 0.025, 0, 0, Math.PI * 2);
    ctx.fill();

    // 小鼻の控えめな影
    ctx.fillStyle = "rgba(95, 55, 50, 0.42)";
    ctx.beginPath();
    ctx.ellipse(noseTipX - faceW * 0.028, noseTipY + faceH * 0.018, faceW * 0.014, faceH * 0.008, 0.2, 0, Math.PI * 2);
    ctx.ellipse(noseTipX + faceW * 0.028, noseTipY + faceH * 0.018, faceW * 0.014, faceH * 0.008, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // =========================================================
    // 8. 口＆リップシンク（Mouth：母音「あ・い・う・え・お」完全新規描画）
    // =========================================================
    ctx.save();
    const mouthCx = px(0, 0.78);
    const mouthCy = py(faceH * 0.255, 0.78);
    const baseMouthW = faceW * 0.28 * (spec.mouth_width_scale || 1.0);
    const spreadFactor = 1 + s.mouthSpread * 0.22 + s.smileWeight * 0.12;
    const mouthW = baseMouthW * spreadFactor;
    const openAmt = s.mouthOpen;
    const smileArch = (s.smileWeight * 0.8 + Math.max(0, s.mouthSpread) * 0.3) * faceH * 0.022;

    if (openAmt < 0.04) {
      // 口閉じ時：本人の唇の厚みと自然な口角ライン
      const lipH = faceH * 0.026 * (spec.lip_thickness || 1.0);
      ctx.fillStyle = spec.lip_hex || "#cc7a74";
      ctx.beginPath();
      ctx.moveTo(mouthCx - mouthW * 0.5, mouthCy - smileArch);
      ctx.quadraticCurveTo(mouthCx, mouthCy - lipH, mouthCx + mouthW * 0.5, mouthCy - smileArch);
      ctx.quadraticCurveTo(mouthCx, mouthCy + lipH * 1.15, mouthCx - mouthW * 0.5, mouthCy - smileArch);
      ctx.closePath();
      ctx.fill();

      // 口の合わせ目ライン
      ctx.strokeStyle = "#522528";
      ctx.lineWidth = Math.max(2.2, S * 0.0034);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(mouthCx - mouthW * 0.52, mouthCy - smileArch);
      ctx.quadraticCurveTo(mouthCx, mouthCy + smileArch * 0.35, mouthCx + mouthW * 0.52, mouthCy - smileArch);
      ctx.stroke();
    } else {
      // 発話時（口開き）：上唇・下唇・口腔・上の歯・舌をベクター描画
      const openH = Math.max(faceH * 0.025, openAmt * faceH * 0.135);
      const topY = mouthCy - openH * 0.32;
      const botY = mouthCy + openH * 0.72;
      const cornerY = mouthCy - smileArch * 0.6;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(mouthCx - mouthW * 0.5, cornerY);
      ctx.quadraticCurveTo(mouthCx, topY, mouthCx + mouthW * 0.5, cornerY);
      ctx.quadraticCurveTo(mouthCx, botY, mouthCx - mouthW * 0.5, cornerY);
      ctx.closePath();
      ctx.clip();

      // 口腔奥
      const cavGrad = ctx.createLinearGradient(mouthCx, topY, mouthCx, botY);
      cavGrad.addColorStop(0, "#240a0e");
      cavGrad.addColorStop(0.6, "#3b1319");
      cavGrad.addColorStop(1, "#2a0d12");
      ctx.fillStyle = cavGrad;
      ctx.fillRect(mouthCx - mouthW * 0.6, topY - 10, mouthW * 1.2, openH * 1.6 + 20);

      // 舌
      ctx.fillStyle = "#bc525a";
      ctx.beginPath();
      ctx.ellipse(mouthCx, botY - openH * 0.12, mouthW * 0.34, openH * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();

      // 上の歯
      const teethH = Math.min(openH * 0.36, faceH * 0.028);
      ctx.fillStyle = "#f8f5f2";
      ctx.fillRect(mouthCx - mouthW * 0.38, topY - 2, mouthW * 0.76, teethH + 4);
      ctx.restore();

      // 唇の輪郭フレーム
      ctx.strokeStyle = "#4a2024";
      ctx.lineWidth = Math.max(2.4, S * 0.0036);
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(mouthCx - mouthW * 0.5, cornerY);
      ctx.quadraticCurveTo(mouthCx, topY, mouthCx + mouthW * 0.5, cornerY);
      ctx.quadraticCurveTo(mouthCx, botY, mouthCx - mouthW * 0.5, cornerY);
      ctx.closePath();
      ctx.stroke();
    }

    // 顎先の小さな立体影
    ctx.strokeStyle = "rgba(95, 55, 50, 0.35)";
    ctx.lineWidth = Math.max(1.6, S * 0.0025);
    ctx.beginPath();
    ctx.arc(mouthCx, py(chinY - faceH * 0.055, 0.65), faceW * 0.04, Math.PI * 0.2, Math.PI * 0.8);
    ctx.stroke();
    ctx.restore();

    // =========================================================
    // 9. 目・虹彩・まぶた・眉（Eyes & Eyebrows：本人の目の形・角度・黒目色で新規描画）
    // =========================================================
    const eyeSpacing = Math.max(0.18, Math.min(0.28, A.rightEye.x - A.leftEye.x));
    const eyeOffsetX = faceW * (eyeSpacing * 1.05);
    const baseEyeY = -faceH * 0.11;
    const eyeW = faceW * 0.21 * (spec.eye_size || 1.0);
    const eyeShape = spec.eye_shape || "almond";
    const baseEyeH =
      eyeShape === "round"
        ? eyeW * 0.56
        : eyeShape === "narrow" || eyeShape === "sharp" || eyeShape === "monolid"
        ? eyeW * 0.40
        : eyeW * 0.48;
    const slantRad = (spec.eye_slant || 0) * 0.45;

    for (const sign of [-1, 1]) {
      const isLeft = sign === -1;
      const blink = isLeft ? s.blinkLeft : s.blinkRight;
      const openRatio = Math.max(0, 1 - blink);
      const curEyeH = baseEyeH * openRatio;

      const ex = px(sign * eyeOffsetX, 0.68);
      const ey = py(baseEyeY, 0.68);
      // 目頭から目尻への傾き（sign = -1 は左目、+1 は右目）
      const outerLift = -slantRad * eyeW * 0.45;
      const innerX = ex - sign * eyeW * 0.5;
      const innerY = ey + outerLift * 0.3;
      const outerX = ex + sign * eyeW * 0.5;
      const outerY = ey + outerLift;

      ctx.save();

      if (openRatio > 0.12) {
        // 1) 白目クリッピングパス
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(innerX, innerY);
        ctx.quadraticCurveTo(ex, ey - curEyeH * 1.05, outerX, outerY);
        ctx.quadraticCurveTo(ex, ey + curEyeH * 0.88, innerX, innerY);
        ctx.closePath();

        ctx.fillStyle = "#faf8f6";
        ctx.fill();
        ctx.clip();

        // 上まぶたの落ち影
        const sclShadow = ctx.createLinearGradient(ex, ey - curEyeH, ex, ey + curEyeH * 0.1);
        sclShadow.addColorStop(0, "rgba(45, 52, 78, 0.32)");
        sclShadow.addColorStop(1, "rgba(45, 52, 78, 0)");
        ctx.fillStyle = sclShadow;
        ctx.fillRect(ex - eyeW, ey - baseEyeH * 1.5, eyeW * 2, baseEyeH * 3);

        // 2) 虹彩（Iris：視線追従）
        const irisR = baseEyeH * 0.92;
        const gazeX = ex + s.lookX * eyeW * 0.16;
        const gazeY = ey + s.lookY * baseEyeH * 0.22;

        const irisGrad = ctx.createRadialGradient(gazeX, gazeY - irisR * 0.2, irisR * 0.1, gazeX, gazeY, irisR);
        irisGrad.addColorStop(0, "#120e14");
        irisGrad.addColorStop(0.55, spec.iris_hex || "#2b1d16");
        irisGrad.addColorStop(0.88, spec.iris_light_hex || "#5c4033");
        irisGrad.addColorStop(1, "#141018");
        ctx.fillStyle = irisGrad;
        ctx.beginPath();
        ctx.arc(gazeX, gazeY, irisR, 0, Math.PI * 2);
        ctx.fill();

        // 瞳孔（Pupil）
        ctx.fillStyle = "#09080c";
        ctx.beginPath();
        ctx.arc(gazeX, gazeY, irisR * 0.42, 0, Math.PI * 2);
        ctx.fill();

        // 瞳下部の三日月反射光
        ctx.fillStyle = "rgba(215, 235, 255, 0.32)";
        ctx.beginPath();
        ctx.arc(gazeX, gazeY + irisR * 0.25, irisR * 0.62, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.fill();

        // キャッチライト（輝き）
        if (shineScale > 0.05) {
          ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(0.96, 0.82 * shineScale)})`;
          ctx.beginPath();
          ctx.arc(
            gazeX - irisR * 0.32,
            gazeY - irisR * 0.32,
            Math.max(1.8, irisR * 0.24 * Math.min(1.3, shineScale)),
            0,
            Math.PI * 2
          );
          ctx.fill();

          ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
          ctx.beginPath();
          ctx.arc(gazeX + irisR * 0.28, gazeY + irisR * 0.28, Math.max(1.0, irisR * 0.12), 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.restore(); // 白目クリップ解除

        // 3) 上まぶた・まつ毛ライン
        ctx.strokeStyle = "#18131a";
        ctx.lineWidth = Math.max(2.8, S * 0.0046);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(innerX, innerY);
        ctx.quadraticCurveTo(ex, ey - curEyeH * 1.08, outerX + sign * 2, outerY);
        ctx.stroke();

        // 下まぶたライン
        ctx.strokeStyle = "rgba(65, 42, 44, 0.52)";
        ctx.lineWidth = Math.max(1.4, S * 0.0022);
        ctx.beginPath();
        ctx.moveTo(innerX + sign * eyeW * 0.1, innerY + 1);
        ctx.quadraticCurveTo(ex, ey + curEyeH * 0.9, outerX - sign * eyeW * 0.06, outerY + 1);
        ctx.stroke();

        // 二重まぶたライン
        if (spec.double_eyelid !== false && spec.eye_shape !== "monolid") {
          ctx.strokeStyle = "rgba(75, 48, 48, 0.45)";
          ctx.lineWidth = Math.max(1.3, S * 0.002);
          ctx.beginPath();
          ctx.moveTo(innerX + sign * eyeW * 0.08, innerY - curEyeH * 0.32);
          ctx.quadraticCurveTo(ex, ey - curEyeH * 1.38, outerX - sign * eyeW * 0.05, outerY - curEyeH * 0.28);
          ctx.stroke();
        }

        // 涙袋の淡い立体影
        if (spec.eye_bags !== false) {
          ctx.strokeStyle = "rgba(145, 92, 85, 0.25)";
          ctx.lineWidth = Math.max(1.2, S * 0.002);
          ctx.beginPath();
          ctx.moveTo(innerX + sign * eyeW * 0.16, innerY + curEyeH * 0.55);
          ctx.quadraticCurveTo(ex, ey + curEyeH * 1.25, outerX - sign * eyeW * 0.16, outerY + curEyeH * 0.55);
          ctx.stroke();
        }
      } else {
        // まばたき閉じ切り時
        ctx.strokeStyle = "#18131a";
        ctx.lineWidth = Math.max(2.8, S * 0.0045);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(innerX, innerY);
        ctx.quadraticCurveTo(ex, ey + baseEyeH * 0.35, outerX + sign * 2, outerY);
        ctx.stroke();
      }

      // 4) 眉毛（Eyebrow：本人の角度・太さ・感情リフトで描画）
      const browLiftY = -s.browLift * faceH * 0.032;
      const browY = ey - baseEyeH * 1.95 + browLiftY;
      const browTiltOffset = -(spec.eyebrow_tilt || 0) * eyeW * 0.45;
      const bInnerX = innerX - sign * eyeW * 0.06;
      const bInnerY = browY - browTiltOffset * 0.4;
      const bMidX = ex + sign * eyeW * 0.06;
      const bMidY = browY - baseEyeH * 0.32 + browTiltOffset * 0.3;
      const bOuterX = outerX + sign * eyeW * 0.14;
      const bOuterY = browY + baseEyeH * 0.08 + browTiltOffset;

      ctx.strokeStyle = hair.darkHex;
      ctx.lineWidth = Math.max(3.2, S * 0.0068 * (spec.eyebrow_thickness || 1.0));
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(bInnerX, bInnerY);
      ctx.quadraticCurveTo(bMidX, bMidY, bOuterX, bOuterY);
      ctx.stroke();

      ctx.restore();
    }

    // =========================================================
    // 10. メガネ（Glasses：着用者の場合に2.5D描画）
    // =========================================================
    if (spec.glasses && spec.glasses !== "none") {
      ctx.save();
      const gY = py(baseEyeY + faceH * 0.01, 0.82);
      const gW = eyeW * 1.28;
      const gH = baseEyeH * 1.85;
      const lGx = px(-eyeOffsetX, 0.82);
      const rGx = px(eyeOffsetX, 0.82);

      ctx.strokeStyle = spec.glasses_hex || "#1c1e28";
      ctx.lineWidth = spec.glasses === "round" ? Math.max(2.2, S * 0.0035) : Math.max(3.0, S * 0.0048);

      for (const gx of [lGx, rGx]) {
        ctx.beginPath();
        if (spec.glasses === "round" || spec.glasses === "boston") {
          ctx.ellipse(gx, gY, gW * 0.54, gH * 0.62, 0, 0, Math.PI * 2);
        } else if (ctx.roundRect) {
          ctx.roundRect(gx - gW * 0.54, gY - gH * 0.58, gW * 1.08, gH * 1.16, 6);
        } else {
          ctx.rect(gx - gW * 0.54, gY - gH * 0.58, gW * 1.08, gH * 1.16);
        }
        ctx.fillStyle = "rgba(180, 225, 255, 0.08)";
        ctx.fill();
        ctx.stroke();

        // レンズの斜め反射ハイライト
        ctx.save();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
        ctx.lineWidth = Math.max(2.0, S * 0.003);
        ctx.beginPath();
        ctx.moveTo(gx - gW * 0.25, gY - gH * 0.35);
        ctx.lineTo(gx - gW * 0.05, gY + gH * 0.25);
        ctx.stroke();
        ctx.restore();
      }

      // ブリッジ＆テンプル
      ctx.beginPath();
      ctx.moveTo(lGx + gW * 0.54, gY - gH * 0.1);
      ctx.quadraticCurveTo(px(0, 0.85), gY - gH * 0.22, rGx - gW * 0.54, gY - gH * 0.1);
      ctx.moveTo(lGx - gW * 0.54, gY - gH * 0.1);
      ctx.lineTo(px(-halfW * 0.98, 0.3), py(cheekY - faceH * 0.08, 0.3));
      ctx.moveTo(rGx + gW * 0.54, gY - gH * 0.1);
      ctx.lineTo(px(halfW * 0.98, 0.3), py(cheekY - faceH * 0.08, 0.3));
      ctx.stroke();
      ctx.restore();
    }

    // =========================================================
    // 11. 前髪・頭頂・サイドヘア（Front Hair & Bangs：本人の分け目・髪型に合わせて新規描画）
    // =========================================================
    ctx.save();
    const topCrownY = foreheadY - faceH * 0.22 * hairVol;
    const hairLineY = foreheadY + faceH * 0.04;
    const bangsTipY = baseEyeY - baseEyeH * 1.35;

    const hairGrad = ctx.createLinearGradient(headCx, py(topCrownY, 0.5), headCx, py(jawY, 0.5));
    hairGrad.addColorStop(0, hair.lightHex);
    hairGrad.addColorStop(0.28, hair.baseHex);
    hairGrad.addColorStop(1, hair.darkHex);

    // 額に落ちる前髪のソフトシャドウ
    ctx.fillStyle = "rgba(45, 25, 32, 0.18)";
    ctx.beginPath();
    ctx.ellipse(px(0, 0.45), py(foreheadY + faceH * 0.12, 0.45), halfW * 0.88, faceH * 0.12, 0, Math.PI, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = hairGrad;
    ctx.strokeStyle = "#12131c";
    ctx.lineWidth = Math.max(2.2, S * 0.0035);
    ctx.lineJoin = "round";

    // 分け目のX位置（センター分け・左分け・右分け・前髪下ろし・オールバック）
    const partX =
      bangsStyle === "parted_left"
        ? -halfW * 0.28
        : bangsStyle === "parted_right"
        ? halfW * 0.26
        : 0;

    const sideLockBottomY = isLongHair ? chinY + faceH * 0.08 : cheekY + faceH * 0.08;

    ctx.beginPath();
    // 頭頂クラウン外形（左もみあげ下端 → 左側頭部 → 頭頂 → 右側頭部 → 右もみあげ下端）
    ctx.moveTo(px(-halfW * 0.96, 0.4), py(sideLockBottomY, 0.4));
    ctx.bezierCurveTo(
      px(-halfW * 1.15 * hairVol, 0.35),
      py(cheekY - faceH * 0.1, 0.35),
      px(-halfW * 1.12 * hairVol, 0.35),
      py(foreheadY - faceH * 0.14, 0.35),
      px(0, 0.4),
      py(topCrownY, 0.4)
    );
    ctx.bezierCurveTo(
      px(halfW * 1.12 * hairVol, 0.35),
      py(foreheadY - faceH * 0.14, 0.35),
      px(halfW * 1.15 * hairVol, 0.35),
      py(cheekY - faceH * 0.1, 0.35),
      px(halfW * 0.96, 0.4),
      py(sideLockBottomY, 0.4)
    );

    // 内側前髪ライン（右もみあげ → 前髪毛束 → 左もみあげ）
    ctx.quadraticCurveTo(
      px(halfW * 0.88, 0.55),
      py(baseEyeY, 0.55),
      px(halfW * 0.78, 0.65),
      py(bangsTipY + faceH * 0.02, 0.65)
    );

    if (bangsStyle === "forehead_open") {
      // おでこ出し・アップバング
      ctx.quadraticCurveTo(
        px(0, 0.65),
        py(foreheadY - faceH * 0.02, 0.65),
        px(-halfW * 0.78, 0.65),
        py(bangsTipY + faceH * 0.02, 0.65)
      );
    } else if (bangsStyle === "full_down") {
      // フルバング（前髪おろし：複数の毛束ギザギザ）
      ctx.lineTo(px(halfW * 0.48, 0.7), py(bangsTipY - faceH * 0.05, 0.7));
      ctx.lineTo(px(halfW * 0.32, 0.72), py(bangsTipY + faceH * 0.01, 0.72));
      ctx.lineTo(px(halfW * 0.12, 0.72), py(bangsTipY - faceH * 0.06, 0.72));
      ctx.lineTo(px(-halfW * 0.04, 0.72), py(bangsTipY + faceH * 0.02, 0.72));
      ctx.lineTo(px(-halfW * 0.24, 0.72), py(bangsTipY - faceH * 0.05, 0.72));
      ctx.lineTo(px(-halfW * 0.45, 0.72), py(bangsTipY + faceH * 0.01, 0.72));
      ctx.lineTo(px(-halfW * 0.78, 0.65), py(bangsTipY + faceH * 0.02, 0.65));
    } else {
      // ナチュラル分け目（センター分け / 左分け / 右分け）
      ctx.quadraticCurveTo(
        px((halfW * 0.78 + partX) * 0.5, 0.72),
        py(bangsTipY + faceH * 0.03, 0.72),
        px(partX + halfW * 0.08, 0.72),
        py(bangsTipY - faceH * 0.02, 0.72)
      );
      // 分け目の切れ込み
      ctx.lineTo(px(partX, 0.68), py(hairLineY - faceH * 0.03, 0.68));
      ctx.lineTo(px(partX - halfW * 0.08, 0.72), py(bangsTipY - faceH * 0.02, 0.72));
      ctx.quadraticCurveTo(
        px((-halfW * 0.78 + partX) * 0.5, 0.72),
        py(bangsTipY + faceH * 0.03, 0.72),
        px(-halfW * 0.78, 0.65),
        py(bangsTipY + faceH * 0.02, 0.65)
      );
    }

    ctx.quadraticCurveTo(
      px(-halfW * 0.88, 0.55),
      py(baseEyeY, 0.55),
      px(-halfW * 0.96, 0.4),
      py(sideLockBottomY, 0.4)
    );
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 髪の天使の輪ハイライト
    const shineY = py(foreheadY - faceH * 0.08, 0.6);
    const shineGrad = ctx.createLinearGradient(headCx - halfW * 0.65, shineY, headCx + halfW * 0.65, shineY);
    shineGrad.addColorStop(0, "rgba(255, 255, 255, 0)");
    shineGrad.addColorStop(0.5, "rgba(255, 255, 255, 0.22)");
    shineGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.strokeStyle = shineGrad;
    ctx.lineWidth = Math.max(4.5, S * 0.008);
    ctx.beginPath();
    ctx.arc(px(0, 0.5), py(cheekY - faceH * 0.05, 0.5), halfW * 0.82, Math.PI * 1.18, Math.PI * 1.82);
    ctx.stroke();
    ctx.restore();

    ctx.restore(); // 頭部回転終了

    // =========================================================
    // 12. アルターエゴ風 モニター走査線（スキャンライン）＆ビネット演出
    // =========================================================
    if (holoIntensity > 0.1) {
      ctx.save();
      const scanAlpha = Math.min(0.12, 0.045 * holoIntensity);
      ctx.fillStyle = `rgba(125, 211, 252, ${scanAlpha})`;
      for (let y = 0; y < S; y += 4) {
        ctx.fillRect(0, y, S, 1);
      }
      ctx.restore();
    }

    const vig = ctx.createRadialGradient(S * 0.5, S * 0.48, S * 0.28, S * 0.5, S * 0.5, S * 0.68);
    vig.addColorStop(0, "rgba(0, 0, 0, 0)");
    vig.addColorStop(0.75, "rgba(0, 0, 0, 0)");
    vig.addColorStop(1, "rgba(2, 6, 14, 0.52)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, S, S);
  }

  /**
   * 写真と顔アンカー（＋AI解析スペック）から、写真のピクセルを一切使わずに
   * 100% 新規描画したアバターキャンバス (720x720) を生成する
   */
  function generateVtuberAvatar(sourceImage, anchors = null, aiSpec = null) {
    const size = 720;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    const A = enrichAnchors(anchors);
    const spec = analyzePhotoToAvatarSpec(sourceImage, A, aiSpec);
    renderNewlyCreatedAvatarFrame(ctx, size, A, spec, null, null);
    canvas._avatarSpec = spec;
    return canvas;
  }

  function generateVtuberSpriteSet(baseImg, openImg, smileImg, rawAnchors, aiSpec = null) {
    const A = enrichAnchors(rawAnchors);
    const spec = analyzePhotoToAvatarSpec(baseImg, A, aiSpec);
    const baseCanvas = generateVtuberAvatar(baseImg, A, spec);
    return {
      vtuber: baseCanvas,
      avatarSpec: spec,
    };
  }

  /**
   * 初期デモ用のポートレートを生成
   */
  function createDemoAvatarCanvas() {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 640;
    const ctx = c.getContext("2d");
    const A = enrichAnchors(createDefaultAnchors());
    const defaultSpec = analyzePhotoToAvatarSpec(null, A, {
      face_shape: "oval",
      jaw_taper: 0.96,
      skin_hex: "#f2c6ab",
      hair_style: "short_neat",
      bangs_style: "parted_right",
      hair_hex: "#1c1d28",
      iris_hex: "#2d1f18",
      eye_shape: "almond",
      double_eyelid: true,
    });
    renderNewlyCreatedAvatarFrame(ctx, 640, A, defaultSpec, null, null);
    c._avatarSpec = defaultSpec;
    return c;
  }

  /**
   * 日本語テキストから現在の母音形状パラメータ (open, spread) を推定するヘルパー
   */
  function analyzeTextVowelHint(text, progressRatio) {
    if (!text) return { open: 0.5, spread: 0.0 };
    const idx = Math.min(text.length - 1, Math.max(0, Math.floor(progressRatio * text.length)));
    const ch = text[idx] || "";
    // あ段
    if (/[あかさたなはまやらわがざだばぱアカサタナハマヤラワガザダバパぁゃャ]/.test(ch)) {
      return { open: 1.0, spread: 0.1 };
    }
    // い段
    if (/[いきしちにひみりぎじぢびぴイキシチニヒミリギジヂビピぃ]/.test(ch)) {
      return { open: 0.38, spread: 0.65 };
    }
    // う段
    if (/[うくすつぬふむゆるぐずづぶぷウクスツヌフムユルグズヅブプぅゅュ]/.test(ch)) {
      return { open: 0.42, spread: -0.55 };
    }
    // え段
    if (/[えけせてねへめれげぜでべぺエケセテネヘメレゲゼデベペぇ]/.test(ch)) {
      return { open: 0.68, spread: 0.45 };
    }
    // お段
    if (/[おこそとのほもよろをごぞどぼぽオコソトノホモヨロヲゴゾドボポぉょョ]/.test(ch)) {
      return { open: 0.78, spread: -0.45 };
    }
    // ん・促音・句読点
    if (/[んンっッ、。！？!?]/.test(ch)) {
      return { open: 0.08, spread: 0.0 };
    }
    return { open: 0.65, spread: 0.0 };
  }

  /**
   * FaceMirrorAvatar クラス
   * キャンバス上に60fpsでリアル2.5D顔アバターを描画・アニメーションする
   */
  class FaceMirrorAvatar {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");

      // 画像テクスチャ（base必須、open・smileは任意、vtuberは自動生成）
      const demoCanvas = createDemoAvatarCanvas();
      this.anchors = enrichAnchors(createDefaultAnchors());
      this.avatarSpec = demoCanvas._avatarSpec || analyzePhotoToAvatarSpec(demoCanvas, this.anchors);
      this.images = {
        base: demoCanvas,
        open: null,
        smile: null,
        vtuber: demoCanvas,
      };
      this.isDemo = true;
      this.avatarName = "デモアバター（写真から新規作成可能）";

      // ランドマーク＆メッシュ
      this.mesh = buildRiggedFaceMesh(this.anchors);

      // 調整パラメータ
      this.settings = {
        mouthSensitivity: 1.25, // 口パク感度
        headMotionScale: 1.0,   // 首の揺れ・うなずき強さ
        depthScale: 1.0,        // 2.5D立体感の強さ
        blinkRate: 1.0,         // まばたき頻度
        showWireframe: false,   // メッシュ確認表示
        avatarStyle: "vtuber",  // "vtuber" (推奨・Vtuberアバター) | "photomesh" (生写真メッシュ)
        vtuberCheek: 1.0,
        vtuberEyeShine: 1.2,
        vtuberMotionScale: 1.15,
        followCursor: true,     // マウス視線・首追従
      };

      // アニメーション状態
      this.state = {
        mode: "idle", // "idle" | "thinking" | "speaking"
        currentSpeechText: "",
        speechStartTime: 0,
        mouthOpen: 0,
        mouthSpread: 0,
        smileWeight: 0.1,
        blinkLeft: 0,
        blinkRight: 0,
        browLift: 0,
        headYaw: 0,
        headPitch: 0,
        headRoll: 0,
        breath: 0,
        targetLookX: 0,
        targetLookY: 0,
        lookX: 0,
        lookY: 0,
      };

      // 外部オーディオアナライザー参照
      this.analyser = null;
      this.freqData = null;
      this.timeData = null;
      this.isAudioActiveFn = () => false;

      // テスト発話シミュレーション用
      this.testSpeakUntil = 0;

      // まばたきタイマー管理
      this.nextBlinkTime = performance.now() + 2200;
      this.blinkDuration = 150;
      this.blinkStart = 0;
      this.isBlinking = false;

      this._bindPointerTracking();
      this._lastFrameTime = performance.now();
      this._rafId = requestAnimationFrame((t) => this._loop(t));
    }

    _bindPointerTracking() {
      window.addEventListener("pointermove", (e) => {
        if (!this.settings.followCursor) {
          this.state.targetLookX = 0;
          this.state.targetLookY = 0;
          return;
        }
        const nx = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
        const ny = (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1;
        this.state.targetLookX = Math.max(-1, Math.min(1, nx * 0.65));
        this.state.targetLookY = Math.max(-1, Math.min(1, ny * 0.55));
      });
    }

    /**
     * Web Audio API の AnalyserNode を接続する
     */
    connectAudioAnalyser(analyser, isAudioActiveFn) {
      this.analyser = analyser;
      if (analyser) {
        this.freqData = new Uint8Array(analyser.frequencyBinCount);
        this.timeData = new Uint8Array(analyser.fftSize);
      }
      if (typeof isAudioActiveFn === "function") {
        this.isAudioActiveFn = isAudioActiveFn;
      }
    }

    /**
     * 対話モード状態を設定 ("idle" | "thinking" | "speaking")
     */
    setMode(mode, speechText = "") {
      this.state.mode = mode;
      if (speechText) {
        this.state.currentSpeechText = speechText;
        this.state.speechStartTime = performance.now();
      }
    }

    /**
     * 口パクテスト発話をトリガー（3.5秒間リアルな発話モーションを再生）
     */
    triggerTestSpeak(text = "こんにちは！写真から作ったリアルアバターだよ。よろしくね！") {
      this.state.currentSpeechText = text;
      this.state.speechStartTime = performance.now();
      this.testSpeakUntil = performance.now() + 3600;
      this.state.mode = "speaking";
    }

    /**
     * アバターデータ（写真URL群・アンカー・設定）をロードしてメッシュを再構築
     */
    async loadAvatarData(avatarData) {
      if (!avatarData || !avatarData.photos || !avatarData.photos.base) {
        this.images.base = createDemoAvatarCanvas();
        this.images.open = null;
        this.images.smile = null;
        this.isDemo = true;
        this.avatarName = "デモアバター";
        this.anchors = enrichAnchors(createDefaultAnchors());
        this.avatarSpec = this.images.base._avatarSpec || analyzePhotoToAvatarSpec(this.images.base, this.anchors);
        this.images.vtuber = this.images.base;
        this.mesh = buildRiggedFaceMesh(this.anchors);
        return;
      }

      const loadImage = (src) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        });

      const baseImg = await loadImage(avatarData.photos.base);
      const normCanvas = this._normalizePortraitImage(baseImg);
      this.images.base = normCanvas;
      this.isDemo = false;
      this.avatarName = avatarData.name || "マイアバター";

      if (avatarData.photos.open) {
        try {
          const openImg = await loadImage(avatarData.photos.open);
          this.images.open = this._normalizePortraitImage(openImg);
        } catch {
          this.images.open = null;
        }
      } else {
        this.images.open = null;
      }

      if (avatarData.photos.smile) {
        try {
          const smileImg = await loadImage(avatarData.photos.smile);
          this.images.smile = this._normalizePortraitImage(smileImg);
        } catch {
          this.images.smile = null;
        }
      } else {
        this.images.smile = null;
      }

      if (avatarData.landmarks && avatarData.landmarks.anchors) {
        this.anchors = enrichAnchors(JSON.parse(JSON.stringify(avatarData.landmarks.anchors)));
      } else {
        const detected = await detectFaceAnchors(normCanvas);
        this.anchors = enrichAnchors(detected.anchors);
      }

      if (avatarData.settings) {
        Object.assign(this.settings, avatarData.settings);
      }

      const aiSpec = (avatarData.landmarks && avatarData.landmarks.avatarSpec) || (avatarData.settings && avatarData.settings.avatarSpec) || null;
      this.avatarSpec = analyzePhotoToAvatarSpec(this.images.base, this.anchors, aiSpec);
      this.images.vtuber = generateVtuberAvatar(this.images.base, this.anchors, this.avatarSpec);
      this.mesh = buildRiggedFaceMesh(this.anchors);
    }

    /**
     * 任意の縦横比の写真を正方形ポートレートキャンバス (720x720) に美しくトリミング正規化
     */
    _normalizePortraitImage(img) {
      const size = 720;
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const ctx = c.getContext("2d");

      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      const scale = Math.max(size / iw, size / ih);
      const sw = iw * scale;
      const sh = ih * scale;
      // 縦長写真では顔が上寄りにあることが多いため少し上寄りを中心にする
      const dx = (size - sw) * 0.5;
      const dy = ih > iw ? (size - sh) * 0.28 : (size - sh) * 0.5;

      ctx.drawImage(img, dx, dy, sw, sh);
      return c;
    }

    /**
     * アンカーを手動更新してメッシュを再計算
     */
    updateAnchors(newAnchors, aiSpecOverride = null) {
      this.anchors = enrichAnchors(JSON.parse(JSON.stringify(newAnchors)));
      this.avatarSpec = analyzePhotoToAvatarSpec(
        this.images.base,
        this.anchors,
        aiSpecOverride || this.avatarSpec
      );
      this.images.vtuber = generateVtuberAvatar(this.images.base, this.anchors, this.avatarSpec);
      this.mesh = buildRiggedFaceMesh(this.anchors);
    }

    /**
     * 毎フレームの物理・音声・表情アップデート
     */
    _updateState(now, dt) {
      const s = this.state;
      const cfg = this.settings;

      // 1. 呼吸（胸・肩のゆったりした上下）
      s.breath = Math.sin(now * 0.0022) * 0.5 + 0.5;

      // 2. まばたき制御（ランダムな自然周期＋時々2回連続まばたき）
      if (!this.isBlinking && now >= this.nextBlinkTime) {
        this.isBlinking = true;
        this.blinkStart = now;
        this.blinkDuration = 135 + Math.random() * 55;
      }

      if (this.isBlinking) {
        const p = (now - this.blinkStart) / this.blinkDuration;
        if (p >= 1) {
          this.isBlinking = false;
          s.blinkLeft = 0;
          s.blinkRight = 0;
          // 18%の確率でダブルブリンク
          const isDouble = Math.random() < 0.18;
          const baseInterval = (2400 + Math.random() * 2800) / Math.max(0.3, cfg.blinkRate);
          this.nextBlinkTime = now + (isDouble ? 180 : baseInterval);
        } else {
          // 閉じる時は速く、開く時は少しゆっくり
          const curve = p < 0.4 ? p / 0.4 : 1 - (p - 0.4) / 0.6;
          const blinkVal = Math.sin(curve * Math.PI * 0.5);
          s.blinkLeft = blinkVal;
          s.blinkRight = blinkVal;
        }
      }

      // 3. 音声解析によるリップシンク計算
      const audioPlaying = this.isAudioActiveFn();
      const testSpeaking = now < this.testSpeakUntil;
      let targetMouthOpen = 0;
      let targetMouthSpread = 0;
      let speechEnergy = 0;

      if (audioPlaying && this.analyser && this.freqData) {
        this.analyser.getByteFrequencyData(this.freqData);
        if (this.timeData) this.analyser.getByteTimeDomainData(this.timeData);

        const binCount = this.freqData.length;
        // 低域〜中域（声の基本周波数＋第1フォルマント F1: 口の開き具合）
        let lowMidSum = 0;
        const lowEnd = Math.max(4, Math.floor(binCount * 0.18));
        for (let i = 1; i < lowEnd; i++) {
          lowMidSum += this.freqData[i];
        }
        const f1Energy = lowMidSum / (lowEnd * 255);

        // 中高域（第2フォルマント F2: い・え等の口の横広がり）
        let highMidSum = 0;
        const midStart = lowEnd;
        const midEnd = Math.max(midStart + 4, Math.floor(binCount * 0.48));
        for (let i = midStart; i < midEnd; i++) {
          highMidSum += this.freqData[i];
        }
        const f2Energy = highMidSum / ((midEnd - midStart) * 255);

        // 時間領域のRMS振幅（子音の破裂や声の強약）
        let rms = 0;
        if (this.timeData) {
          let sq = 0;
          for (let i = 0; i < this.timeData.length; i++) {
            const v = (this.timeData[i] - 128) / 128;
            sq += v * v;
          }
          rms = Math.sqrt(sq / this.timeData.length);
        }

        speechEnergy = Math.min(1.0, (f1Energy * 1.35 + rms * 1.9) * cfg.mouthSensitivity);

        // 日本語テキストの母音ヒントと音響フォルマントを融合
        const elapsedSec = (now - s.speechStartTime) / 1000;
        const estDuration = Math.max(1.2, (s.currentSpeechText.length || 10) * 0.16);
        const progress = (elapsedSec % estDuration) / estDuration;
        const vowelHint = analyzeTextVowelHint(s.currentSpeechText, progress);

        if (speechEnergy > 0.04) {
          targetMouthOpen = Math.min(
            1.0,
            speechEnergy * (0.65 + 0.35 * vowelHint.open)
          );
          const formantSpread = (f2Energy - f1Energy * 0.55) * 2.2;
          targetMouthSpread = Math.max(
            -0.6,
            Math.min(0.75, formantSpread * 0.55 + vowelHint.spread * 0.45)
          );
        }
      } else if (testSpeaking) {
        // テスト発話シミュレーション波形
        const t = (now - s.speechStartTime) * 0.001;
        const syllableWave = Math.max(0, Math.sin(t * 16.5) * 0.7 + Math.sin(t * 7.3) * 0.4);
        const progress = Math.min(1, (now - s.speechStartTime) / 3600);
        const vowelHint = analyzeTextVowelHint(s.currentSpeechText, progress);
        speechEnergy = syllableWave * cfg.mouthSensitivity;
        targetMouthOpen = Math.min(0.95, syllableWave * vowelHint.open * cfg.mouthSensitivity);
        targetMouthSpread = vowelHint.spread * 0.65;
      } else if (s.mode === "speaking") {
        s.mode = "idle";
      }

      // 口の開閉スムージング（開くときは素早く、閉じるときは自然な弾성）
      const openLerp = targetMouthOpen > s.mouthOpen ? Math.min(1, dt * 26) : Math.min(1, dt * 15);
      s.mouthOpen += (targetMouthOpen - s.mouthOpen) * openLerp;
      s.mouthSpread += (targetMouthSpread - s.mouthSpread) * Math.min(1, dt * 12);

      // 4. 表情・眉・笑顔ウェイト
      const targetSmile =
        audioPlaying || testSpeaking
          ? 0.22 + Math.max(0, s.mouthSpread) * 0.45
          : s.mode === "thinking"
          ? 0.02
          : 0.14 + Math.sin(now * 0.0008) * 0.05;
      s.smileWeight += (targetSmile - s.smileWeight) * Math.min(1, dt * 6);

      const targetBrow =
        audioPlaying || testSpeaking
          ? speechEnergy * 0.55 + Math.sin(now * 0.006) * 0.15
          : s.mode === "thinking"
          ? 0.35
          : Math.sin(now * 0.0012) * 0.08;
      s.browLift += (targetBrow - s.browLift) * Math.min(1, dt * 8);

      // 5. 視線＆首の立体モーション（待機・思考中・発話中で自然な振る舞いに変化）
      let lookTargetX = s.targetLookX;
      let lookTargetY = s.targetLookY;
      if (s.mode === "thinking") {
        // 考え中は少し斜め上を見る人間らしい仕草
        lookTargetX = 0.42 + Math.sin(now * 0.002) * 0.12;
        lookTargetY = -0.35;
      } else if (audioPlaying || testSpeaking) {
        // 発話中はユーザー（正面）をしっかり見つつリズムに乗る
        lookTargetX *= 0.35;
        lookTargetY *= 0.35;
      }

      s.lookX += (lookTargetX - s.lookX) * Math.min(1, dt * 5);
      s.lookY += (lookTargetY - s.lookY) * Math.min(1, dt * 5);

      const idleYaw = Math.sin(now * 0.0011) * 0.22 + Math.sin(now * 0.0027) * 0.08;
      const idlePitch = Math.sin(now * 0.0015) * 0.16;
      const idleRoll = Math.sin(now * 0.0009) * 0.18;

      const talkNod = (audioPlaying || testSpeaking)
        ? Math.sin(now * 0.0085) * speechEnergy * 0.55 + speechEnergy * 0.25
        : 0;
      const talkSway = (audioPlaying || testSpeaking)
        ? Math.sin(now * 0.0042) * speechEnergy * 0.35
        : 0;

      s.headYaw = (idleYaw + s.lookX * 0.65 + talkSway) * cfg.headMotionScale;
      s.headPitch = (idlePitch + s.lookY * 0.55 + talkNod) * cfg.headMotionScale;
      s.headRoll = (idleRoll + s.lookX * 0.2 + talkSway * 0.5) * cfg.headMotionScale;
    }

    /**
     * 各頂点のアニメーション変形後の 2D 座標を計算
     */
    _computeDeformedVertices(width, height) {
      const s = this.state;
      const cfg = this.settings;
      const a = this.anchors;
      const cx = a.faceCenter.x;
      const cy = a.faceCenter.y;
      const faceH = Math.max(0.22, a.chin.y - a.forehead.y);
      const faceW = Math.max(0.20, a.rightCheek.x - a.leftCheek.x);

      const yaw = s.headYaw * 0.032 * cfg.depthScale;
      const pitch = s.headPitch * 0.028 * cfg.depthScale;
      const roll = s.headRoll * 0.035 * cfg.headMotionScale;
      const cosR = Math.cos(roll);
      const sinR = Math.sin(roll);

      const leftEyeH = Math.max(0.015, a.leftEyeBottom.y - a.leftEyeTop.y);
      const rightEyeH = Math.max(0.015, a.rightEyeBottom.y - a.rightEyeTop.y);
      const jawDrop = s.mouthOpen * faceH * 0.145;
      const mouthWide = s.mouthSpread * faceW * 0.065 + s.smileWeight * faceW * 0.035;
      const smileLift = (s.smileWeight + Math.max(0, s.mouthSpread) * 0.5) * faceH * 0.028;

      const isAlterEgo = cfg.avatarStyle === "vtuber";
      const floatY = isAlterEgo ? -Math.sin(s.breath * Math.PI) * 0.012 : 0;

      for (const v of this.mesh.vertices) {
        if (v.role === "bg" && !isAlterEgo) {
          v.x = v.u * width;
          v.y = v.v * height;
          continue;
        }

        let dx = 0;
        let dy = 0;

        // 1. 部位ごとのローカル表情変形
        switch (v.role) {
          case "shoulder":
            dy -= s.breath * 0.008;
            break;

          case "brow_l":
          case "brow_r":
            dy -= s.browLift * faceH * 0.035 * v.weight;
            break;

          case "eyelid_top_l":
            // まばたきで上まぶたが下まぶたの位置まで降りる
            dy += s.blinkLeft * leftEyeH * 0.92;
            break;
          case "eyelid_bot_l":
            dy -= s.blinkLeft * leftEyeH * 0.12 - s.smileWeight * leftEyeH * 0.18;
            break;

          case "eyelid_top_r":
            dy += s.blinkRight * rightEyeH * 0.92;
            break;
          case "eyelid_bot_r":
            dy -= s.blinkRight * rightEyeH * 0.12 - s.smileWeight * rightEyeH * 0.18;
            break;

          case "cheek_l":
            dx -= mouthWide * 0.35;
            dy -= smileLift * 0.7 + jawDrop * 0.12;
            break;
          case "cheek_r":
            dx += mouthWide * 0.35;
            dy -= smileLift * 0.7 + jawDrop * 0.12;
            break;

          case "mouth_corner_l":
            dx -= mouthWide;
            dy += jawDrop * 0.26 - smileLift;
            break;
          case "mouth_corner_r":
            dx += mouthWide;
            dy += jawDrop * 0.26 - smileLift;
            break;

          case "lip_upper_outer":
            dy -= s.mouthOpen * faceH * 0.018 * v.weight;
            break;
          case "lip_upper_inner":
            // 上唇内側は少し持ち上がり、口内の隙間を作る
            dy -= s.mouthOpen * faceH * 0.022 * v.weight;
            break;

          case "lip_lower_inner":
            // 下唇内側は顎の開きに合わせて大きく下がる
            dy += jawDrop * 0.95 * v.weight;
            break;
          case "lip_lower_outer":
            dy += jawDrop * 0.88 * v.weight;
            break;

          case "chin":
            dy += jawDrop * 0.75 * v.weight;
            break;
          case "jaw":
            dy += jawDrop * 0.38 * v.weight;
            break;
        }

        // 2. 2.5D 立体回転（Z深度に応じたパララックス移動＋首の傾き回転）
        const relX = v.u + dx - cx;
        const relY = v.v + dy - cy;
        const rotX = relX * cosR - relY * sinR;
        const rotY = relX * sinR + relY * cosR;

        // Z値が大きい部位（鼻先・唇・眉間）ほど首を振ったときに大きく立体移動する
        // アルターエゴ（首から上だけ）モードでは頭部全体が一体となって空間をスイングし、生写真のような引き攣れを防ぐ
        const effectiveWeight = isAlterEgo ? Math.max(0.72, v.weight) : v.weight;
        const effectiveZ = isAlterEgo && v.role === "bg" ? 0.05 : v.z;
        const depthFactor = (effectiveZ + 0.25) * effectiveWeight;
        const perspectiveX = yaw * depthFactor * (1 - Math.abs(relX) * 0.35);
        const perspectiveY = pitch * depthFactor * (1 - Math.abs(relY) * 0.35) + floatY;

        v.x = (cx + rotX + perspectiveX) * width;
        v.y = (cy + rotY + perspectiveY) * height;
      }
    }

    /**
     * 口が開いたときのリアルな口内（上の歯・舌・口内陰影・または open 写真テクスチャ）を描画
     */
    _renderMouthCavity(ctx, width, height) {
      const openAmt = this.state.mouthOpen;
      if (openAmt < 0.025) return;

      const ring = this.mesh.mouthCavityRing;
      const V = this.mesh.vertices;
      const pL = V[ring.left];
      const pUL = V[ring.upperL];
      const pUC = V[ring.upperC];
      const pUR = V[ring.upperR];
      const pR = V[ring.right];
      const pLR = V[ring.lowerR];
      const pLC = V[ring.lowerC];
      const pLL = V[ring.lowerL];

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pL.x, pL.y);
      ctx.quadraticCurveTo(pUL.x, pUL.y, pUC.x, pUC.y);
      ctx.quadraticCurveTo(pUR.x, pUR.y, pR.x, pR.y);
      ctx.quadraticCurveTo(pLR.x, pLR.y, pLC.x, pLC.y);
      ctx.quadraticCurveTo(pLL.x, pLL.y, pL.x, pL.y);
      ctx.closePath();
      ctx.clip();

      // もし「口を開けた写真 (open)」が登録されている場合は、その口内テクスチャをブレンド
      if (this.images.open) {
        ctx.drawImage(this.images.open, 0, 0, width, height);
      } else {
        // 1枚の写真からでも自然に見える3Dシェーディング口内（口腔の暗がり＋上の歯＋舌の立体陰影）
        const mouthH = Math.max(4, pLC.y - pUC.y);
        const mouthW = Math.max(12, pR.x - pL.x);

        // 1) 口腔奥のダークグラデーション
        const cavGrad = ctx.createRadialGradient(
          pUC.x,
          pUC.y + mouthH * 0.45,
          mouthW * 0.05,
          pUC.x,
          pUC.y + mouthH * 0.5,
          mouthW * 0.65
        );
        cavGrad.addColorStop(0, "#240b0e");
        cavGrad.addColorStop(0.65, "#3a1217");
        cavGrad.addColorStop(1, "#180608");
        ctx.fillStyle = cavGrad;
        ctx.fillRect(pL.x - 10, pUC.y - 10, mouthW + 20, mouthH + 20);

        // 2) 舌の柔らかな赤み（口が大きく開いたときに見える）
        if (openAmt > 0.18) {
          const tongueGrad = ctx.createRadialGradient(
            pLC.x,
            pLC.y - mouthH * 0.12,
            mouthW * 0.04,
            pLC.x,
            pLC.y,
            mouthW * 0.42
          );
          tongueGrad.addColorStop(0, "rgba(188, 76, 82, 0.85)");
          tongueGrad.addColorStop(0.7, "rgba(135, 42, 48, 0.75)");
          tongueGrad.addColorStop(1, "rgba(70, 18, 22, 0)");
          ctx.fillStyle = tongueGrad;
          ctx.beginPath();
          ctx.ellipse(
            pLC.x,
            pLC.y - mouthH * 0.1,
            mouthW * 0.34,
            mouthH * 0.42,
            0,
            0,
            Math.PI * 2
          );
          ctx.fill();
        }

        // 3) 上の歯列（自然なアイボリー＋両端の陰影）
        const teethVisibleH = Math.min(mouthH * 0.38, width * 0.022 * Math.min(1, openAmt * 1.8));
        if (teethVisibleH > 1.2) {
          const teethGrad = ctx.createLinearGradient(pL.x, pUC.y, pR.x, pUC.y);
          teethGrad.addColorStop(0, "rgba(160, 145, 140, 0.5)");
          teethGrad.addColorStop(0.18, "rgba(242, 236, 230, 0.92)");
          teethGrad.addColorStop(0.5, "rgba(252, 248, 244, 0.96)");
          teethGrad.addColorStop(0.82, "rgba(242, 236, 230, 0.92)");
          teethGrad.addColorStop(1, "rgba(160, 145, 140, 0.5)");

          ctx.fillStyle = teethGrad;
          ctx.beginPath();
          ctx.moveTo(pL.x + mouthW * 0.1, pUC.y - 2);
          ctx.lineTo(pR.x - mouthW * 0.1, pUC.y - 2);
          ctx.quadraticCurveTo(
            pR.x - mouthW * 0.12,
            pUC.y + teethVisibleH,
            pUC.x,
            pUC.y + teethVisibleH
          );
          ctx.quadraticCurveTo(
            pL.x + mouthW * 0.12,
            pUC.y + teethVisibleH,
            pL.x + mouthW * 0.1,
            pUC.y - 2
          );
          ctx.closePath();
          ctx.fill();
        }

        // 4) 唇内側のソフトシャドウ（合成感をなくすエッジフェザー）
        const innerShadow = ctx.createLinearGradient(0, pUC.y, 0, pLC.y);
        innerShadow.addColorStop(0, "rgba(20, 5, 8, 0.65)");
        innerShadow.addColorStop(0.22, "rgba(20, 5, 8, 0.0)");
        innerShadow.addColorStop(0.82, "rgba(20, 5, 8, 0.0)");
        innerShadow.addColorStop(1, "rgba(20, 5, 8, 0.55)");
        ctx.fillStyle = innerShadow;
        ctx.fillRect(pL.x - 4, pUC.y - 4, mouthW + 8, mouthH + 8);
      }

      ctx.restore();
    }

    /**
     * メイン描画ループ
     */
    _loop(now) {
      const dt = Math.min(0.05, Math.max(0.001, (now - this._lastFrameTime) / 1000));
      this._lastFrameTime = now;

      this._updateState(now, dt);
      this.render();

      this._rafId = requestAnimationFrame((t) => this._loop(t));
    }

    render() {
      const canvas = this.canvas;
      const ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;

      const targetW = Math.round(rect.width * dpr);
      const targetH = Math.round(rect.height * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = rect.width;
      const H = rect.height;

      ctx.clearRect(0, 0, W, H);

      // 正方形アバターステージを中央に配置（全画面時もアスペクト比を維持して美しく表示）
      const stageSize = Math.max(W, H);
      const offsetX = (W - stageSize) * 0.5;
      const offsetY = (H - stageSize) * 0.5;

      ctx.save();
      ctx.translate(offsetX, offsetY);

      // 頂点変形計算
      this._computeDeformedVertices(stageSize, stageSize);

      const baseImg = this.images.base;
      const imgW = baseImg.width || baseImg.naturalWidth || 640;
      const imgH = baseImg.height || baseImg.naturalHeight || 640;

      // 1. 口内の描画（唇メッシュの背面に配置）
      // スタイルに応じた描画分岐
      if (this.settings.avatarStyle === "vtuber") {
        this._renderVtuberAvatar(ctx, stageSize);
        ctx.restore();
        ctx.restore();
        return;
      }

      this._renderMouthCavity(ctx, stageSize, stageSize);

      // 2. 2.5D 三角形メッシュのテクスチャワープ描画
      const V = this.mesh.vertices;
      for (const [i0, i1, i2] of this.mesh.triangles) {
        const v0 = V[i0];
        const v1 = V[i1];
        const v2 = V[i2];
        drawTexturedTriangle(
          ctx,
          baseImg,
          v0.u * imgW,
          v0.v * imgH,
          v1.u * imgW,
          v1.v * imgH,
          v2.u * imgW,
          v2.v * imgH,
          v0.x,
          v0.y,
          v1.x,
          v1.y,
          v2.x,
          v2.y
        );
      }

      // 3. 笑顔写真 (smile) が登録されている場合のマルチ写真ブレンド
      if (this.images.smile && this.state.smileWeight > 0.18) {
        const alpha = Math.min(0.65, (this.state.smileWeight - 0.18) * 1.4);
        ctx.save();
        ctx.globalAlpha = alpha;
        const sImg = this.images.smile;
        const sW = sImg.width || 640;
        const sH = sImg.height || 640;
        for (const [i0, i1, i2] of this.mesh.triangles) {
          const v0 = V[i0];
          const v1 = V[i1];
          const v2 = V[i2];
          if (v0.role === "bg") continue;
          drawTexturedTriangle(
            ctx,
            sImg,
            v0.u * sW,
            v0.v * sH,
            v1.u * sW,
            v1.v * sH,
            v2.u * sW,
            v2.v * sH,
            v0.x,
            v0.y,
            v1.x,
            v1.y,
            v2.x,
            v2.y
          );
        }
        ctx.restore();
      }

      // 4. 首の動きに連動する立体陰影（2.5D ダイナミックシェーディング）
      const lightX = stageSize * (0.5 - this.state.headYaw * 0.22);
      const lightY = stageSize * (0.42 - this.state.headPitch * 0.2);
      const dynLight = ctx.createRadialGradient(
        lightX,
        lightY,
        stageSize * 0.08,
        stageSize * 0.5,
        stageSize * 0.5,
        stageSize * 0.62
      );
      dynLight.addColorStop(0, "rgba(255, 250, 245, 0.04)");
      dynLight.addColorStop(0.65, "rgba(0, 0, 0, 0)");
      dynLight.addColorStop(1, "rgba(5, 8, 22, 0.38)");
      ctx.fillStyle = dynLight;
      ctx.fillRect(0, 0, stageSize, stageSize);

      // 5. ワイヤーフレーム確認表示（ONのときのみ）
      if (this.settings.showWireframe) {
        ctx.save();
        ctx.strokeStyle = "rgba(70, 225, 255, 0.42)";
        ctx.lineWidth = 0.9;
        for (const [i0, i1, i2] of this.mesh.triangles) {
          const v0 = V[i0];
          const v1 = V[i1];
          const v2 = V[i2];
          if (v0.role === "bg" && v1.role === "bg" && v2.role === "bg") continue;
          ctx.beginPath();
          ctx.moveTo(v0.x, v0.y);
          ctx.lineTo(v1.x, v1.y);
          ctx.lineTo(v2.x, v2.y);
          ctx.closePath();
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.restore();
      ctx.restore();
    }

    /**
     * 「Vtuberの顔をそのまま人の顔にする」ハイブリッド 2.5D Vtuber アバター描画
     * - 背景・身体・衣装・首・後ろ髪・サイドヘアは Live2D 風のクリーンな 2D/2.5D イラストとしてアニメーション
     * - 顔部分は写真から生成・美肌調和した「本人の顔」を Vtuber 輪郭に綺麗に切り抜いて融合し、
     *   まばたき・瞳の輝き・視線追従・リップシンク・首の揺れで違和感なく自然に動かす
     */
    /**
     * 「ダンガンロンパのアルターエゴ」風・首から上だけで写真の人そっくりに動くデジタルアバター描画
     * - 余計なアニメ衣装やキャラパーツは一切描かず、写真から生成した「本人の首から上」だけをモニター空間に浮遊表示
     * - 頭部全体が一体となって自然にうなずき・傾き、本人の目・眉・口が滑らかに表情変化＆リップシンクする
     */
    /**
     * 方法A（アルターエゴ方式）：
     * 三角形メッシュによる顔写真のゴムのような引き伸ばしを一切行わず、
     * 事前生成した「首から上だけ・本人そっくり」の表情差分スプライト（通常・半開き・口開け・笑顔・目閉じ）を
     * 音声のフォルマント＆まばたきに合わせて高速に切り替えて描画する。
     */
    /**
     * 写真のピクセルを一切貼り付けず、写真からAI＆ランドマーク解析した特徴データ (this.avatarSpec) を基に
     * 100% 新規描画した 2.5D デジタルアバター（首から上だけ・アルターエゴ風）を 60fps でリアルタイムアニメーション描画する
     */
    _renderVtuberAvatar(ctx, stageSize) {
      const A = enrichAnchors(this.anchors);
      if (!this.avatarSpec) {
        this.avatarSpec = analyzePhotoToAvatarSpec(this.images.base, A);
      }
      renderNewlyCreatedAvatarFrame(ctx, stageSize, A, this.avatarSpec, this.state, this.settings);
    }
  }

  global.FaceMirrorEngine = {
    generateVtuberAvatar,
    analyzePhotoToAvatarSpec,
    generateVtuberSpriteSet,
    createDemoAvatarCanvas,
    FaceMirrorAvatar,
    detectFaceAnchors,
    createDefaultAnchors,
    buildRiggedFaceMesh,
  };
})(window);

