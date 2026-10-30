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
   * Mirai Vtuber Avatar Generator & Hybrid Live2D Face Styling Pipeline
   * 「Vtuberの顔をそのまま人の顔にする」ハイブリッド生成エンジン：
   * - 写真から本人の顔立ち・肌色・髪色を抽出し、不気味な生写真感を消す美肌セルシェーディングを適用
   * - Live2D風の2.5D身体・衣装・首・髪パーツと本人の顔をシームレスに融合
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
      if (w <= 0 || h <= 0) return { r: 242, g: 202, b: 182 };
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
        : { r: 242, g: 202, b: 182 };
    } catch (_) {
      return { r: 242, g: 202, b: 182 };
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

  function clampSkinPalette(rawSkin) {
    // 暗い照明の写真でもVtuberの首・耳・肌トーンが健康的で綺麗に見えるよう補正
    const lum = rawSkin.r * 0.299 + rawSkin.g * 0.587 + rawSkin.b * 0.114;
    const boost = lum < 155 ? Math.min(1.45, 175 / Math.max(60, lum)) : lum > 235 ? 0.94 : 1.04;
    const r = Math.min(252, Math.max(195, Math.round(rawSkin.r * boost + 8)));
    const g = Math.min(232, Math.max(158, Math.round(rawSkin.g * boost + 4)));
    const b = Math.min(218, Math.max(138, Math.round(rawSkin.b * boost + 2)));
    return {
      r,
      g,
      b,
      baseHex: rgbToHex(r, g, b),
      lightHex: rgbToHex(Math.min(255, r + 14), Math.min(255, g + 12), Math.min(255, b + 12)),
      shadowHex: rgbToHex(Math.round(r * 0.84), Math.round(g * 0.78), Math.round(b * 0.78)),
      deepShadowHex: rgbToHex(Math.round(r * 0.68), Math.round(g * 0.60), Math.round(b * 0.62)),
    };
  }

  function clampHairPalette(rawHair) {
    const r = Math.min(210, Math.max(20, rawHair.r));
    const g = Math.min(200, Math.max(18, rawHair.g));
    const b = Math.min(220, Math.max(24, rawHair.b));
    return {
      r,
      g,
      b,
      baseHex: rgbToHex(r, g, b),
      darkHex: rgbToHex(Math.round(r * 0.65), Math.round(g * 0.65), Math.round(b * 0.70)),
      lightHex: rgbToHex(Math.min(255, r + 48), Math.min(255, g + 45), Math.min(255, b + 55)),
    };
  }

  /**
   * 写真と顔アンカーから、Vtuberの頭部にそのまま自然に馴染む「美肌・アニメ調スタイライズ顔テクスチャ (720x720)」を生成する
   * 本人の目・眉・鼻・メガネ・髪型などの個性を維持したまま、生写真のザラつきや不気味さを解消する
   */
  function generateVtuberAvatar(sourceImage, anchors = null, options = {}) {
    const size = 720;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const A = enrichAnchors(anchors);

    // 1. 元写真をキャンバスに描画
    ctx.drawImage(sourceImage, 0, 0, size, size);

    // 2. 本人の肌色・髪色・唇色をサンプリング
    const sNose = sampleAverageRgb(ctx, A.noseBridge.x * size, A.noseBridge.y * size, 9);
    const sCheekL = sampleAverageRgb(
      ctx,
      (A.leftCheek.x * 0.55 + A.noseTip.x * 0.45) * size,
      A.leftCheek.y * size,
      10
    );
    const sCheekR = sampleAverageRgb(
      ctx,
      (A.rightCheek.x * 0.55 + A.noseTip.x * 0.45) * size,
      A.rightCheek.y * size,
      10
    );
    const avgSkin = {
      r: Math.round((sNose.r + sCheekL.r + sCheekR.r) / 3),
      g: Math.round((sNose.g + sCheekL.g + sCheekR.g) / 3),
      b: Math.round((sNose.b + sCheekL.b + sCheekR.b) / 3),
    };
    const skinPalette = clampSkinPalette(avgSkin);

    const hairSampleY = Math.max(12, (A.forehead.y - (A.chin.y - A.forehead.y) * 0.28) * size);
    const rawHair = sampleAverageRgb(ctx, A.forehead.x * size, hairSampleY, 14);
    const hairPalette = clampHairPalette(rawHair);

    const lipRgb = sampleAverageRgb(ctx, A.lipCenter.x * size, A.lipCenter.y * size, 6);

    // 3. Vtuber 美肌・セルルック調和フィルター（目・眉・メガネ・髪の輪郭はくっきり保ちつつ肌を陶器のように滑らかに）
    try {
      const imgData = ctx.getImageData(0, 0, size, size);
      const d = imgData.data;

      const faceCx = A.faceCenter.x * size;
      const faceCy = A.faceCenter.y * size;
      const rx = Math.max(80, (A.rightCheek.x - A.leftCheek.x) * size * 0.68);
      const ry = Math.max(100, (A.chin.y - A.forehead.y) * size * 0.72);

      // 目と口の保護領域（シャープさを100%維持する）
      const lEyeX = A.leftEye.x * size;
      const lEyeY = A.leftEye.y * size;
      const rEyeX = A.rightEye.x * size;
      const rEyeY = A.rightEye.y * size;
      const eyeProtectR = Math.max(24, (A.rightEye.x - A.leftEye.x) * size * 0.24);

      const mouthCx = A.lipCenter.x * size;
      const mouthCy = A.lipCenter.y * size;
      const mouthProtectRx = Math.max(28, (A.mouthRight.x - A.mouthLeft.x) * size * 0.62);
      const mouthProtectRy = Math.max(18, (A.lowerLipBottom.y - A.upperLipTop.y) * size * 0.85);

      for (let y = 0; y < size; y++) {
        const ny = (y - faceCy) / ry;
        if (Math.abs(ny) > 1.25) continue;
        for (let x = 0; x < size; x++) {
          const nx = (x - faceCx) / rx;
          const ellDist = Math.hypot(nx, ny);
          if (ellDist > 1.2) continue;

          // 目・口の中心部はディテールを保護
          const dLEye = Math.hypot(x - lEyeX, y - lEyeY);
          const dREye = Math.hypot(x - rEyeX, y - rEyeY);
          if (dLEye < eyeProtectR || dREye < eyeProtectR) continue;
          const dMouth = Math.hypot((x - mouthCx) / mouthProtectRx, (y - mouthCy) / mouthProtectRy);
          if (dMouth < 0.9) continue;

          const idx = (y * size + x) * 4;
          const r = d[idx];
          const g = d[idx + 1];
          const b = d[idx + 2];

          // 肌色ピクセル判定（影や色ムラをアニメ美肌トーンへソフトに均一化）
          const colorDiff = Math.abs(r - avgSkin.r) + Math.abs(g - avgSkin.g) + Math.abs(b - avgSkin.b);
          if (colorDiff < 135 && r > g * 0.92 && g > b * 0.82) {
            const radialWeight = Math.max(0, 1 - ellDist / 1.2);
            const smoothStrength = radialWeight * 0.46;
            // 元の陰影ニュアンスを少し残しながらVtuberの明るい美肌トーンへ寄せる
            const targetR = skinPalette.r * 0.72 + Math.min(255, r * 1.06) * 0.28;
            const targetG = skinPalette.g * 0.72 + Math.min(255, g * 1.05) * 0.28;
            const targetB = skinPalette.b * 0.72 + Math.min(255, b * 1.05) * 0.28;

            d[idx] = Math.min(255, Math.round(r * (1 - smoothStrength) + targetR * smoothStrength));
            d[idx + 1] = Math.min(255, Math.round(g * (1 - smoothStrength) + targetG * smoothStrength));
            d[idx + 2] = Math.min(255, Math.round(b * (1 - smoothStrength) + targetB * smoothStrength));
          }
        }
      }
      ctx.putImageData(imgData, 0, 0);
    } catch (_) {}

    // 4. 顔全体のソフトアニメライティング（鼻筋のハイライトと頬の透明感）
    ctx.save();
    const noseBridgeX = A.noseBridge.x * size;
    const noseBridgeY = A.noseBridge.y * size;
    const noseTipX = A.noseTip.x * size;
    const noseTipY = A.noseTip.y * size;

    // 鼻筋〜鼻先のアニメ調ハイライト
    ctx.strokeStyle = "rgba(255, 252, 250, 0.36)";
    ctx.lineWidth = 3.2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(noseBridgeX, noseBridgeY + 4);
    ctx.lineTo(noseTipX, noseTipY - 4);
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 252, 250, 0.45)";
    ctx.beginPath();
    ctx.arc(noseTipX, noseTipY - 1, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    canvas._vtuberPalette = {
      skin: skinPalette,
      hair: hairPalette,
      lip: lipRgb,
    };

    return canvas;
  }

  function createDemoAvatarCanvas() {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 640;
    const ctx = c.getContext("2d");

    // 背景グラデーション
    const bg = ctx.createRadialGradient(320, 260, 40, 320, 320, 420);
    bg.addColorStop(0, "#242b48");
    bg.addColorStop(1, "#0d1021");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 640, 640);

    // 肩・ジャケット
    const suitGrad = ctx.createLinearGradient(160, 480, 480, 640);
    suitGrad.addColorStop(0, "#1e243b");
    suitGrad.addColorStop(1, "#121626");
    ctx.fillStyle = suitGrad;
    ctx.beginPath();
    ctx.moveTo(100, 640);
    ctx.quadraticCurveTo(140, 500, 250, 485);
    ctx.lineTo(390, 485);
    ctx.quadraticCurveTo(500, 500, 540, 640);
    ctx.closePath();
    ctx.fill();

    // 首
    const neckGrad = ctx.createLinearGradient(270, 410, 370, 520);
    neckGrad.addColorStop(0, "#e2b296");
    neckGrad.addColorStop(1, "#c48f73");
    ctx.fillStyle = neckGrad;
    ctx.fillRect(268, 420, 104, 95);

    // 後ろ髪
    ctx.fillStyle = "#181822";
    ctx.beginPath();
    ctx.ellipse(320, 250, 155, 175, 0, 0, Math.PI * 2);
    ctx.fill();

    // 耳
    ctx.fillStyle = "#dfa98c";
    ctx.beginPath();
    ctx.ellipse(178, 305, 18, 34, -0.1, 0, Math.PI * 2);
    ctx.ellipse(462, 305, 18, 34, 0.1, 0, Math.PI * 2);
    ctx.fill();

    // 顔輪郭（立体感のある肌シェーディング）
    const skinGrad = ctx.createRadialGradient(320, 265, 25, 320, 295, 175);
    skinGrad.addColorStop(0, "#ffdfc9");
    skinGrad.addColorStop(0.55, "#f2c1a5");
    skinGrad.addColorStop(1, "#d1997c");
    ctx.fillStyle = skinGrad;
    ctx.beginPath();
    ctx.moveTo(185, 235);
    ctx.bezierCurveTo(180, 355, 225, 455, 320, 488);
    ctx.bezierCurveTo(415, 455, 460, 355, 455, 235);
    ctx.bezierCurveTo(450, 130, 190, 130, 185, 235);
    ctx.closePath();
    ctx.fill();

    // 頬の自然な血色
    const cheekL = ctx.createRadialGradient(238, 330, 5, 238, 330, 48);
    cheekL.addColorStop(0, "rgba(235, 125, 115, 0.24)");
    cheekL.addColorStop(1, "rgba(235, 125, 115, 0)");
    ctx.fillStyle = cheekL;
    ctx.fillRect(185, 280, 110, 100);

    const cheekR = ctx.createRadialGradient(402, 330, 5, 402, 330, 48);
    cheekR.addColorStop(0, "rgba(235, 125, 115, 0.24)");
    cheekR.addColorStop(1, "rgba(235, 125, 115, 0)");
    ctx.fillStyle = cheekR;
    ctx.fillRect(345, 280, 110, 100);

    // 眉
    ctx.strokeStyle = "#2b2422";
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(212, 222);
    ctx.quadraticCurveTo(248, 204, 286, 218);
    ctx.moveTo(354, 218);
    ctx.quadraticCurveTo(392, 204, 428, 222);
    ctx.stroke();

    // 目（白目・虹彩・瞳孔・ハイライト）
    const drawRealisticEye = (cx, cy) => {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx - 32, cy);
      ctx.quadraticCurveTo(cx, cy - 17, cx + 32, cy + 2);
      ctx.quadraticCurveTo(cx, cy + 15, cx - 32, cy);
      ctx.closePath();
      ctx.fillStyle = "#faf8f6";
      ctx.fill();
      ctx.clip();

      // 虹彩
      const irisGrad = ctx.createRadialGradient(cx, cy, 3, cx, cy, 15);
      irisGrad.addColorStop(0, "#120e0c");
      irisGrad.addColorStop(0.5, "#3b271c");
      irisGrad.addColorStop(0.9, "#22150e");
      irisGrad.addColorStop(1, "#110b08");
      ctx.fillStyle = irisGrad;
      ctx.beginPath();
      ctx.arc(cx, cy - 1, 14, 0, Math.PI * 2);
      ctx.fill();

      // 瞳孔
      ctx.fillStyle = "#08080a";
      ctx.beginPath();
      ctx.arc(cx, cy - 1, 6, 0, Math.PI * 2);
      ctx.fill();

      // キャッチライト
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.beginPath();
      ctx.arc(cx - 4, cy - 5, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      ctx.arc(cx + 5, cy + 3, 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 上まぶたライン
      ctx.strokeStyle = "#2a1d19";
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(cx - 33, cy + 1);
      ctx.quadraticCurveTo(cx, cy - 18, cx + 33, cy + 2);
      ctx.stroke();
    };

    drawRealisticEye(250, 258);
    drawRealisticEye(390, 258);

    // 鼻筋・鼻先陰影
    ctx.strokeStyle = "rgba(165, 110, 85, 0.35)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(314, 255);
    ctx.quadraticCurveTo(310, 305, 306, 322);
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 245, 238, 0.45)";
    ctx.beginPath();
    ctx.ellipse(320, 316, 7, 16, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(145, 92, 70, 0.45)";
    ctx.beginPath();
    ctx.ellipse(307, 330, 6, 3.5, 0.2, 0, Math.PI * 2);
    ctx.ellipse(333, 330, 6, 3.5, -0.2, 0, Math.PI * 2);
    ctx.fill();

    // 唇（上唇・下唇・口角）
    ctx.fillStyle = "#cf7b75";
    ctx.beginPath();
    ctx.moveTo(264, 394);
    ctx.quadraticCurveTo(295, 378, 320, 383);
    ctx.quadraticCurveTo(345, 378, 376, 394);
    ctx.quadraticCurveTo(345, 397, 320, 395);
    ctx.quadraticCurveTo(295, 397, 264, 394);
    ctx.fill();

    const lowerLipGrad = ctx.createLinearGradient(320, 394, 320, 414);
    lowerLipGrad.addColorStop(0, "#df8c85");
    lowerLipGrad.addColorStop(0.6, "#eb9d96");
    lowerLipGrad.addColorStop(1, "#c46e68");
    ctx.fillStyle = lowerLipGrad;
    ctx.beginPath();
    ctx.moveTo(264, 394);
    ctx.quadraticCurveTo(320, 397, 376, 394);
    ctx.quadraticCurveTo(352, 415, 320, 415);
    ctx.quadraticCurveTo(288, 415, 264, 394);
    ctx.fill();

    // 口の合わせ目ライン
    ctx.strokeStyle = "#8a423e";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(263, 394);
    ctx.quadraticCurveTo(295, 396, 320, 394);
    ctx.quadraticCurveTo(345, 396, 377, 394);
    ctx.stroke();

    // 前髪
    ctx.fillStyle = "#1a1b26";
    ctx.beginPath();
    ctx.moveTo(175, 245);
    ctx.quadraticCurveTo(185, 115, 320, 110);
    ctx.quadraticCurveTo(455, 115, 465, 245);
    ctx.quadraticCurveTo(430, 185, 385, 210);
    ctx.quadraticCurveTo(355, 165, 315, 208);
    ctx.quadraticCurveTo(275, 165, 235, 205);
    ctx.quadraticCurveTo(200, 185, 175, 245);
    ctx.closePath();
    ctx.fill();

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
      this.images = {
        base: demoCanvas,
        open: null,
        smile: null,
        vtuber: generateVtuberAvatar(demoCanvas, this.anchors),
      };
      this.isDemo = true;
      this.avatarName = "デモアバター（写真から作成可能）";

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
        this.images.vtuber = generateVtuberAvatar(this.images.base, this.anchors);
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

      this.images.vtuber = generateVtuberAvatar(this.images.base, this.anchors);
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
    updateAnchors(newAnchors) {
      this.anchors = enrichAnchors(JSON.parse(JSON.stringify(newAnchors)));
      this.images.vtuber = generateVtuberAvatar(this.images.base, this.anchors);
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

      for (const v of this.mesh.vertices) {
        if (v.role === "bg") {
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
        const depthFactor = (v.z + 0.25) * v.weight;
        const perspectiveX = yaw * depthFactor * (1 - Math.abs(relX) * 0.4);
        const perspectiveY = pitch * depthFactor * (1 - Math.abs(relY) * 0.4);

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
    _renderVtuberAvatar(ctx, stageSize) {
      const S = stageSize;
      const s = this.state;
      const cfg = this.settings;
      const A = enrichAnchors(this.anchors);
      const V = this.mesh.vertices;
      const C = this.mesh.contourRing;

      if (!this.images.vtuber && this.images.base) {
        this.images.vtuber = generateVtuberAvatar(this.images.base, A);
      }
      const vtuberFaceImg = this.images.vtuber || this.images.base;
      const imgW = vtuberFaceImg.width || 720;
      const imgH = vtuberFaceImg.height || 720;

      const palette = vtuberFaceImg._vtuberPalette || {
        skin: clampSkinPalette({ r: 240, g: 198, b: 176 }),
        hair: clampHairPalette({ r: 30, g: 30, b: 44 }),
        lip: { r: 210, g: 115, b: 115 },
      };

      const now = performance.now();

      // =========================================================
      // 1. Vtuber 配信スタジオ背景（生写真の背景を切り離し、アバター空間を構築）
      // =========================================================
      const bgGrad = ctx.createRadialGradient(S * 0.5, S * 0.38, S * 0.05, S * 0.5, S * 0.5, S * 0.72);
      bgGrad.addColorStop(0, "#1e2444");
      bgGrad.addColorStop(0.55, "#11152b");
      bgGrad.addColorStop(1, "#080a16");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, S, S);

      // 背後のソフトネオンオーラ（発話中に優しく脈動）
      const auraPulse = 1 + (s.mode === "speaking" ? s.mouthOpen * 0.18 : Math.sin(now * 0.002) * 0.05);
      const auraGrad = ctx.createRadialGradient(
        S * 0.5,
        S * 0.42,
        S * 0.04,
        S * 0.5,
        S * 0.42,
        S * 0.42 * auraPulse
      );
      auraGrad.addColorStop(0, "rgba(99, 102, 241, 0.28)");
      auraGrad.addColorStop(0.5, "rgba(56, 189, 248, 0.12)");
      auraGrad.addColorStop(1, "rgba(56, 189, 248, 0)");
      ctx.fillStyle = auraGrad;
      ctx.fillRect(0, 0, S, S);

      // ステージの浮遊パーティクル
      ctx.save();
      for (let i = 0; i < 8; i++) {
        const px = S * (0.12 + ((i * 0.11 + Math.sin(now * 0.0004 + i) * 0.03) % 0.78));
        const py = S * (0.15 + ((i * 0.13 + Math.cos(now * 0.0005 + i * 1.7) * 0.04) % 0.72));
        const pr = S * (0.003 + (i % 3) * 0.0018);
        ctx.fillStyle = i % 2 === 0 ? "rgba(125, 211, 252, 0.28)" : "rgba(196, 181, 253, 0.24)";
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // 顔の基準メトリクス（変形後の顎・頬・額）
      const chinPt = V[C.chinC];
      const jawLPt = V[C.jawL];
      const jawRPt = V[C.jawR];
      const cheekLPt = V[C.cheekOuterL];
      const cheekRPt = V[C.cheekOuterR];
      const foreheadPt = V[C.foreheadC];
      const hTopPt = V[C.hTop];

      const faceW = Math.max(S * 0.24, cheekRPt.x - cheekLPt.x);
      const faceH = Math.max(S * 0.28, chinPt.y - foreheadPt.y);
      const headCx = (cheekLPt.x + cheekRPt.x) * 0.5;
      const headCy = (foreheadPt.y + chinPt.y) * 0.5;

      // 呼吸・身体の揺れオフセット
      const breathY = -s.breath * S * 0.008;
      const bodySwayX = s.headYaw * S * 0.018 * cfg.headMotionScale;
      const bodyRoll = s.headRoll * 0.022 * cfg.headMotionScale;
      const neckBaseX = A.chin.x * S + bodySwayX;
      const neckTopY = A.chin.y * S - faceH * 0.08 + breathY;
      const shoulderY = Math.min(S * 0.88, A.chin.y * S + faceH * 0.28) + breathY;

      // =========================================================
      // 2. Vtuber 後ろ髪（首・肩の背後に配置し、揺れに追従）
      // =========================================================
      ctx.save();
      const hairSwayX = s.headYaw * S * 0.028;
      const backHairGrad = ctx.createLinearGradient(headCx, hTopPt.y, headCx, shoulderY + faceH * 0.25);
      backHairGrad.addColorStop(0, palette.hair.baseHex);
      backHairGrad.addColorStop(1, palette.hair.darkHex);
      ctx.fillStyle = backHairGrad;
      ctx.beginPath();
      ctx.ellipse(
        headCx - hairSwayX * 0.35,
        headCy + faceH * 0.05,
        faceW * 0.64,
        faceH * 0.72,
        s.headRoll * 0.03,
        0,
        Math.PI * 2
      );
      ctx.fill();
      ctx.restore();

      // =========================================================
      // 3. Vtuber の首＆上半身・配信者衣装（Live2D イラストボディ）
      // =========================================================
      ctx.save();
      ctx.translate(neckBaseX, shoulderY);
      ctx.rotate(bodyRoll);
      ctx.translate(-neckBaseX, -shoulderY);

      const neckW = Math.max(S * 0.11, faceW * 0.34);
      const neckH = Math.max(S * 0.10, shoulderY - neckTopY + S * 0.04);

      // 3a. 首（写真から抽出した本人の肌色に完全一致）
      const neckGrad = ctx.createLinearGradient(neckBaseX - neckW * 0.5, neckTopY, neckBaseX + neckW * 0.5, neckTopY + neckH);
      neckGrad.addColorStop(0, palette.skin.shadowHex);
      neckGrad.addColorStop(0.35, palette.skin.baseHex);
      neckGrad.addColorStop(1, palette.skin.shadowHex);
      ctx.fillStyle = neckGrad;
      ctx.beginPath();
      ctx.moveTo(neckBaseX - neckW * 0.46, neckTopY);
      ctx.quadraticCurveTo(neckBaseX - neckW * 0.44, neckTopY + neckH * 0.55, neckBaseX - neckW * 0.62, neckTopY + neckH);
      ctx.lineTo(neckBaseX + neckW * 0.62, neckTopY + neckH);
      ctx.quadraticCurveTo(neckBaseX + neckW * 0.44, neckTopY + neckH * 0.55, neckBaseX + neckW * 0.46, neckTopY);
      ctx.closePath();
      ctx.fill();

      // 顎下のアニメセル影（顔と首の立体的な境界を作る）
      const chinDropShadow = ctx.createRadialGradient(
        chinPt.x,
        chinPt.y + faceH * 0.02,
        neckW * 0.08,
        chinPt.x,
        chinPt.y + faceH * 0.05,
        neckW * 0.62
      );
      chinDropShadow.addColorStop(0, "rgba(58, 32, 42, 0.52)");
      chinDropShadow.addColorStop(0.65, "rgba(58, 32, 42, 0.22)");
      chinDropShadow.addColorStop(1, "rgba(58, 32, 42, 0)");
      ctx.fillStyle = chinDropShadow;
      ctx.beginPath();
      ctx.ellipse(chinPt.x, chinPt.y + faceH * 0.04, neckW * 0.52, faceH * 0.11, 0, 0, Math.PI * 2);
      ctx.fill();

      // 首の輪郭線と鎖骨ハイライト
      ctx.strokeStyle = "rgba(52, 32, 38, 0.55)";
      ctx.lineWidth = Math.max(1.8, S * 0.003);
      ctx.beginPath();
      ctx.moveTo(neckBaseX - neckW * 0.45, neckTopY + neckH * 0.1);
      ctx.quadraticCurveTo(neckBaseX - neckW * 0.44, neckTopY + neckH * 0.55, neckBaseX - neckW * 0.58, neckTopY + neckH * 0.92);
      ctx.moveTo(neckBaseX + neckW * 0.45, neckTopY + neckH * 0.1);
      ctx.quadraticCurveTo(neckBaseX + neckW * 0.44, neckTopY + neckH * 0.55, neckBaseX + neckW * 0.58, neckTopY + neckH * 0.92);
      ctx.stroke();

      // 3b. Vtuber 衣装（スタイリッシュなレイヤードジャケット＆インナー）
      const torsoTopY = neckTopY + neckH * 0.68;
      const shoulderSpan = Math.max(S * 0.66, faceW * 1.75);
      const bottomY = S + 20;

      // インナーシャツ
      const innerGrad = ctx.createLinearGradient(neckBaseX, torsoTopY, neckBaseX, bottomY);
      innerGrad.addColorStop(0, "#f8fafc");
      innerGrad.addColorStop(1, "#cbd5e1");
      ctx.fillStyle = innerGrad;
      ctx.beginPath();
      ctx.moveTo(neckBaseX - neckW * 0.72, torsoTopY);
      ctx.quadraticCurveTo(neckBaseX, torsoTopY + neckH * 0.38, neckBaseX + neckW * 0.72, torsoTopY);
      ctx.lineTo(neckBaseX + neckW * 0.95, bottomY);
      ctx.lineTo(neckBaseX - neckW * 0.95, bottomY);
      ctx.closePath();
      ctx.fill();

      // メインジャケット（アウター）
      const jacketGrad = ctx.createLinearGradient(neckBaseX - shoulderSpan * 0.5, torsoTopY, neckBaseX + shoulderSpan * 0.5, bottomY);
      jacketGrad.addColorStop(0, "#1e293b");
      jacketGrad.addColorStop(0.5, "#0f172a");
      jacketGrad.addColorStop(1, "#1e1b4b");
      ctx.fillStyle = jacketGrad;

      ctx.beginPath();
      ctx.moveTo(neckBaseX - neckW * 0.62, torsoTopY - S * 0.01);
      ctx.quadraticCurveTo(
        neckBaseX - shoulderSpan * 0.42,
        torsoTopY + S * 0.02,
        neckBaseX - shoulderSpan * 0.54,
        bottomY
      );
      ctx.lineTo(neckBaseX + shoulderSpan * 0.54, bottomY);
      ctx.quadraticCurveTo(
        neckBaseX + shoulderSpan * 0.42,
        torsoTopY + S * 0.02,
        neckBaseX + neckW * 0.62,
        torsoTopY - S * 0.01
      );
      // Vネックの切り込み
      ctx.lineTo(neckBaseX + neckW * 0.28, bottomY);
      ctx.lineTo(neckBaseX - neckW * 0.28, bottomY);
      ctx.closePath();
      ctx.fill();

      // ジャケットの襟（ラペル）とサイバーアクセントライン
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = Math.max(2.2, S * 0.004);
      ctx.beginPath();
      ctx.moveTo(neckBaseX - neckW * 0.62, torsoTopY - S * 0.005);
      ctx.lineTo(neckBaseX - neckW * 0.26, bottomY);
      ctx.moveTo(neckBaseX + neckW * 0.62, torsoTopY - S * 0.005);
      ctx.lineTo(neckBaseX + neckW * 0.26, bottomY);
      ctx.stroke();

      // ネクタイ / リボンエンブレム
      const tieGrad = ctx.createLinearGradient(neckBaseX, torsoTopY + S * 0.03, neckBaseX, bottomY);
      tieGrad.addColorStop(0, "#6366f1");
      tieGrad.addColorStop(1, "#0ea5e9");
      ctx.fillStyle = tieGrad;
      ctx.beginPath();
      ctx.moveTo(neckBaseX, torsoTopY + S * 0.025);
      ctx.lineTo(neckBaseX + neckW * 0.16, torsoTopY + S * 0.065);
      ctx.lineTo(neckBaseX + neckW * 0.11, bottomY);
      ctx.lineTo(neckBaseX - neckW * 0.11, bottomY);
      ctx.lineTo(neckBaseX - neckW * 0.16, torsoTopY + S * 0.065);
      ctx.closePath();
      ctx.fill();

      // 肩・ジャケットのアニメ線画
      ctx.strokeStyle = "#090d16";
      ctx.lineWidth = Math.max(2.4, S * 0.0042);
      ctx.beginPath();
      ctx.moveTo(neckBaseX - neckW * 0.62, torsoTopY - S * 0.01);
      ctx.quadraticCurveTo(
        neckBaseX - shoulderSpan * 0.42,
        torsoTopY + S * 0.02,
        neckBaseX - shoulderSpan * 0.54,
        bottomY
      );
      ctx.moveTo(neckBaseX + neckW * 0.62, torsoTopY - S * 0.01);
      ctx.quadraticCurveTo(
        neckBaseX + shoulderSpan * 0.42,
        torsoTopY + S * 0.02,
        neckBaseX + shoulderSpan * 0.54,
        bottomY
      );
      ctx.stroke();

      ctx.restore(); // 上半身終了

      // =========================================================
      // 4. 両耳（本人の肌トーンで顔の左右に配置）
      // =========================================================
      const earW = faceW * 0.075;
      const earH = faceH * 0.135;
      const earY = (cheekLPt.y + cheekRPt.y) * 0.5 - faceH * 0.02;

      for (const isLeft of [true, false]) {
        const earX = isLeft ? cheekLPt.x - earW * 0.35 : cheekRPt.x + earW * 0.35;
        ctx.save();
        ctx.fillStyle = palette.skin.baseHex;
        ctx.strokeStyle = "rgba(55, 34, 40, 0.55)";
        ctx.lineWidth = Math.max(1.8, S * 0.003);
        ctx.beginPath();
        ctx.ellipse(earX, earY, earW, earH, isLeft ? -0.14 : 0.14, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // 耳の中の陰影
        ctx.fillStyle = palette.skin.shadowHex;
        ctx.beginPath();
        ctx.ellipse(earX + (isLeft ? 2 : -2), earY + 1, earW * 0.5, earH * 0.55, isLeft ? -0.1 : 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // =========================================================
      // 5. 写真から生成した「本人の顔 2.5D メッシュ」を Vtuber 頭部シルエットに切り抜いて描画
      // =========================================================
      const hTopLPt = V[C.hTopL];
      const hTopRPt = V[C.hTopR];
      const hMidLPt = V[C.hMidL];
      const hMidRPt = V[C.hMidR];
      const chinLPt = V[C.chinL];
      const chinRPt = V[C.chinR];

      // 頭部〜顎ラインの滑らかなベジェクリッピングパス（写真の背景や四角い枠を完全に除去）
      const traceHeadSilhouette = () => {
        ctx.beginPath();
        ctx.moveTo(hTopPt.x, hTopPt.y - faceH * 0.04);
        // 左側頭頂〜こめかみ
        ctx.quadraticCurveTo(hTopLPt.x - faceW * 0.08, hTopLPt.y, hMidLPt.x - faceW * 0.02, hMidLPt.y);
        // 左頬〜左エラ
        ctx.quadraticCurveTo(cheekLPt.x - faceW * 0.01, (cheekLPt.y + jawLPt.y) * 0.5, jawLPt.x, jawLPt.y);
        // 左エラ〜顎先（シャープで美しいVtuberフェイスライン）
        ctx.quadraticCurveTo(chinLPt.x, chinLPt.y + faceH * 0.015, chinPt.x, chinPt.y + faceH * 0.01);
        // 顎先〜右エラ
        ctx.quadraticCurveTo(chinRPt.x, chinRPt.y + faceH * 0.015, jawRPt.x, jawRPt.y);
        // 右エラ〜右頬
        ctx.quadraticCurveTo(cheekRPt.x + faceW * 0.01, (cheekRPt.y + jawRPt.y) * 0.5, hMidRPt.x + faceW * 0.02, hMidRPt.y);
        // 右こめかみ〜頭頂
        ctx.quadraticCurveTo(hTopRPt.x + faceW * 0.08, hTopRPt.y, hTopPt.x, hTopPt.y - faceH * 0.04);
        ctx.closePath();
      };

      ctx.save();
      traceHeadSilhouette();
      ctx.clip();

      // 5a. 口が開いたときの口内（歯・舌・口内陰影）を描画
      this._renderMouthCavity(ctx, S, S);

      // 5b. 本人の顔メッシュ（背景と肩の三角形を除外し、頭部・顔のみワープ描画）
      for (const [i0, i1, i2] of this.mesh.triangles) {
        const v0 = V[i0];
        const v1 = V[i1];
        const v2 = V[i2];
        if (v0.role === "bg" || v1.role === "bg" || v2.role === "bg") continue;
        if (v0.role === "shoulder" && v1.role === "shoulder" && v2.role === "shoulder") continue;

        drawTexturedTriangle(
          ctx,
          vtuberFaceImg,
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

      // 5c. 笑顔写真 (smile) が登録されている場合のマルチ写真ブレンド
      if (this.images.smile && s.smileWeight > 0.18) {
        const alpha = Math.min(0.65, (s.smileWeight - 0.18) * 1.4);
        ctx.save();
        ctx.globalAlpha = alpha;
        const sImg = this.images.smile;
        const sW = sImg.width || 720;
        const sH = sImg.height || 720;
        for (const [i0, i1, i2] of this.mesh.triangles) {
          const v0 = V[i0];
          const v1 = V[i1];
          const v2 = V[i2];
          if (v0.role === "bg" || v1.role === "bg" || v2.role === "bg") continue;
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

      // 5d. フェイスライン内側のソフトシェーディング（写真の切り抜き境界を馴染ませる）
      const edgeGrad = ctx.createRadialGradient(
        headCx,
        headCy,
        faceW * 0.32,
        headCx,
        headCy,
        faceW * 0.62
      );
      edgeGrad.addColorStop(0, "rgba(0, 0, 0, 0)");
      edgeGrad.addColorStop(0.78, "rgba(0, 0, 0, 0)");
      edgeGrad.addColorStop(1, "rgba(40, 22, 30, 0.22)");
      ctx.fillStyle = edgeGrad;
      ctx.fillRect(0, 0, S, S);

      ctx.restore(); // 頭部クリッピング終了

      // =========================================================
      // 6. Vtuber 輪郭線＆サイドヘア毛束・頭頂ハイライト（本人の顔とVtuber頭部を完全一体化）
      // =========================================================
      ctx.save();

      // 6a. 顎〜頬のシャープなアニメ輪郭線
      ctx.strokeStyle = "rgba(48, 28, 36, 0.72)";
      ctx.lineWidth = Math.max(2.2, S * 0.0038);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(cheekLPt.x - faceW * 0.005, cheekLPt.y);
      ctx.quadraticCurveTo(cheekLPt.x, (cheekLPt.y + jawLPt.y) * 0.5, jawLPt.x, jawLPt.y);
      ctx.quadraticCurveTo(chinLPt.x, chinLPt.y + faceH * 0.015, chinPt.x, chinPt.y + faceH * 0.01);
      ctx.quadraticCurveTo(chinRPt.x, chinRPt.y + faceH * 0.015, jawRPt.x, jawRPt.y);
      ctx.quadraticCurveTo(cheekRPt.x, (cheekRPt.y + jawRPt.y) * 0.5, cheekRPt.x + faceW * 0.005, cheekRPt.y);
      ctx.stroke();

      // 6b. サイドヘア（もみあげ・顔横の揺れる毛束で切り抜き境界を自然にカバー）
      const sideHairGrad = ctx.createLinearGradient(headCx, hTopPt.y, headCx, jawLPt.y + faceH * 0.15);
      sideHairGrad.addColorStop(0, palette.hair.baseHex);
      sideHairGrad.addColorStop(1, palette.hair.darkHex);
      ctx.fillStyle = sideHairGrad;
      ctx.strokeStyle = "rgba(20, 16, 28, 0.65)";
      ctx.lineWidth = Math.max(1.6, S * 0.0028);

      // 左サイド毛束
      ctx.beginPath();
      ctx.moveTo(hTopLPt.x - faceW * 0.03, hTopLPt.y + faceH * 0.02);
      ctx.quadraticCurveTo(
        hMidLPt.x - faceW * 0.08,
        cheekLPt.y,
        jawLPt.x - faceW * 0.02 - hairSwayX * 0.25,
        jawLPt.y + faceH * 0.12
      );
      ctx.quadraticCurveTo(
        cheekLPt.x + faceW * 0.02,
        cheekLPt.y + faceH * 0.02,
        hMidLPt.x + faceW * 0.02,
        hTopLPt.y + faceH * 0.12
      );
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // 右サイド毛束
      ctx.beginPath();
      ctx.moveTo(hTopRPt.x + faceW * 0.03, hTopRPt.y + faceH * 0.02);
      ctx.quadraticCurveTo(
        hMidRPt.x + faceW * 0.08,
        cheekRPt.y,
        jawRPt.x + faceW * 0.02 - hairSwayX * 0.25,
        jawRPt.y + faceH * 0.12
      );
      ctx.quadraticCurveTo(
        cheekRPt.x - faceW * 0.02,
        cheekRPt.y + faceH * 0.02,
        hMidRPt.x - faceW * 0.02,
        hTopRPt.y + faceH * 0.12
      );
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // 6c. 頭頂部の天使の輪（アニメヘアハイライト）
      const haloY = (hTopPt.y + foreheadPt.y) * 0.5;
      const haloGrad = ctx.createLinearGradient(headCx - faceW * 0.3, haloY, headCx + faceW * 0.3, haloY);
      haloGrad.addColorStop(0, "rgba(255, 255, 255, 0)");
      haloGrad.addColorStop(0.5, "rgba(255, 255, 255, 0.26)");
      haloGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.strokeStyle = haloGrad;
      ctx.lineWidth = Math.max(4, faceH * 0.025);
      ctx.beginPath();
      ctx.arc(headCx, haloY + faceH * 0.18, faceW * 0.36, Math.PI * 1.18, Math.PI * 1.82);
      ctx.stroke();

      ctx.restore();

      // =========================================================
      // 7. Vtuber チーク・瞳ハイライト・まばたき・リップラインのリアルタイム描画
      // =========================================================
      this._renderVtuberCheeks(ctx, S, faceW);
      this._renderVtuberEyes(ctx, S, palette);
      this._renderVtuberMouth(ctx, S);

      // ワイヤーフレーム確認表示（ONのときのみ）
      if (cfg.showWireframe) {
        ctx.save();
        ctx.strokeStyle = "rgba(70, 225, 255, 0.45)";
        ctx.lineWidth = 0.9;
        for (const [i0, i1, i2] of this.mesh.triangles) {
          const v0 = V[i0];
          const v1 = V[i1];
          const v2 = V[i2];
          if (v0.role === "bg" || v1.role === "bg" || v2.role === "bg") continue;
          ctx.beginPath();
          ctx.moveTo(v0.x, v0.y);
          ctx.lineTo(v1.x, v1.y);
          ctx.lineTo(v2.x, v2.y);
          ctx.closePath();
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    /**
     * Vtuber チーク（頬の血色＆斜線ハイライト）
     */
    _renderVtuberCheeks(ctx, stageSize, faceW) {
      const cheekScale = this.settings.vtuberCheek !== undefined ? this.settings.vtuberCheek : 1.0;
      if (cheekScale <= 0.02) return;

      const V = this.mesh.vertices;
      const ch = this.mesh.cheekIndices;
      if (!ch) return;

      const ptL = V[ch.left];
      const ptR = V[ch.right];
      const radius = Math.max(12, faceW * 0.12);
      const alpha = Math.min(0.65, (0.26 + this.state.smileWeight * 0.25) * cheekScale);

      ctx.save();
      for (const pt of [ptL, ptR]) {
        const g = ctx.createRadialGradient(pt.x, pt.y, radius * 0.1, pt.x, pt.y, radius);
        g.addColorStop(0, `rgba(255, 115, 145, ${alpha})`);
        g.addColorStop(0.55, `rgba(255, 135, 160, ${alpha * 0.45})`);
        g.addColorStop(1, "rgba(255, 150, 170, 0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
        ctx.fill();

        // 可愛い斜線チークハイライト
        if (cheekScale > 0.4) {
          ctx.strokeStyle = `rgba(255, 255, 255, ${Math.min(0.65, alpha * 0.9)})`;
          ctx.lineWidth = Math.max(1.5, stageSize * 0.0026);
          ctx.lineCap = "round";
          for (const dx of [-4, 3]) {
            ctx.beginPath();
            ctx.moveTo(pt.x + dx - 3, pt.y - 3);
            ctx.lineTo(pt.x + dx + 3, pt.y + 4);
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    }

    /**
     * Vtuber アイ（本人の目にきらめく瞳ハイライト・アイライン・滑らかなまばたきを付与）
     */
    _renderVtuberEyes(ctx, stageSize, palette) {
      const V = this.mesh.vertices;
      const rings = this.mesh.eyeRings;
      if (!rings) return;

      const shineScale = this.settings.vtuberEyeShine !== undefined ? this.settings.vtuberEyeShine : 1.2;
      const s = this.state;

      const eyes = [
        { ring: rings.left, blink: s.blinkLeft, isLeft: true },
        { ring: rings.right, blink: s.blinkRight, isLeft: false },
      ];

      for (const { ring, blink, isLeft } of eyes) {
        const pOuter = V[ring.outer];
        const pInner = V[ring.inner];
        const pTop = V[ring.top];
        const pBot = V[ring.bottom];

        const cx = (pOuter.x + pInner.x) * 0.5;
        const cy = (pTop.y + pBot.y) * 0.5;
        const eyeW = Math.max(12, Math.hypot(pInner.x - pOuter.x, pInner.y - pOuter.y));
        const openH = Math.max(0, pBot.y - pTop.y);

        ctx.save();

        // まばたき時（目を閉じている最中）は肌色のまぶたシェイプで綺麗に閉じる
        if (blink > 0.25) {
          ctx.fillStyle = palette.skin.baseHex;
          ctx.beginPath();
          ctx.ellipse(cx, cy, eyeW * 0.54, Math.max(3, eyeW * 0.22), 0, 0, Math.PI * 2);
          ctx.fill();
        }

        // 目が開いているときは、視線に追従するVtuberデュアルキャッチライト（瞳の輝き）を描画
        if (blink < 0.65 && shineScale > 0.05) {
          const gazeShiftX = s.lookX * eyeW * 0.08;
          const gazeShiftY = s.lookY * eyeW * 0.05;
          const rMain = Math.max(2.0, eyeW * 0.095 * Math.min(1.4, shineScale));
          const rSub = Math.max(1.2, eyeW * 0.055 * Math.min(1.4, shineScale));

          // メインハイライト（斜め上）
          ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(0.96, 0.72 * shineScale)})`;
          ctx.beginPath();
          ctx.arc(
            cx - eyeW * 0.1 + gazeShiftX,
            cy - openH * 0.16 + gazeShiftY,
            rMain,
            0,
            Math.PI * 2
          );
          ctx.fill();

          // サブハイライト（斜め下）
          ctx.fillStyle = `rgba(235, 248, 255, ${Math.min(0.88, 0.58 * shineScale)})`;
          ctx.beginPath();
          ctx.arc(
            cx + eyeW * 0.11 + gazeShiftX * 0.6,
            cy + openH * 0.14 + gazeShiftY * 0.6,
            rSub,
            0,
            Math.PI * 2
          );
          ctx.fill();
        }

        // 上まつ毛・アイライン（まばたきに完全連動して上下する）
        ctx.strokeStyle = "#1c1624";
        ctx.lineWidth = Math.max(2.2, eyeW * 0.085);
        ctx.lineCap = "round";
        ctx.beginPath();
        const leftPt = isLeft ? pOuter : pInner;
        const rightPt = isLeft ? pInner : pOuter;
        ctx.moveTo(leftPt.x - (isLeft ? 2 : 0), leftPt.y);
        ctx.quadraticCurveTo(pTop.x, pTop.y - openH * 0.22, rightPt.x + (isLeft ? 0 : 2), rightPt.y);
        ctx.stroke();

        ctx.restore();
      }
    }

    /**
     * Vtuber リップライン（発話・笑顔の口元をくっきり見せる）
     */
    _renderVtuberMouth(ctx, stageSize) {
      const ring = this.mesh.mouthCavityRing;
      if (!ring) return;
      const V = this.mesh.vertices;
      const pL = V[ring.left];
      const pUC = V[ring.upperC];
      const pR = V[ring.right];
      const pLC = V[ring.lowerC];

      ctx.save();
      ctx.strokeStyle = "rgba(85, 38, 46, 0.62)";
      ctx.lineWidth = Math.max(1.6, stageSize * 0.0028);
      ctx.lineCap = "round";

      // 上唇のM字ライン
      ctx.beginPath();
      ctx.moveTo(pL.x, pL.y);
      ctx.quadraticCurveTo((pL.x + pUC.x) * 0.5, pUC.y - 1.5, pUC.x, pUC.y);
      ctx.quadraticCurveTo((pR.x + pUC.x) * 0.5, pUC.y - 1.5, pR.x, pR.y);
      ctx.stroke();

      // 口が開いているときは下唇の輪郭も優しく引き締める
      if (this.state.mouthOpen > 0.05) {
        ctx.strokeStyle = "rgba(95, 42, 52, 0.45)";
        ctx.beginPath();
        ctx.moveTo(pL.x, pL.y);
        ctx.quadraticCurveTo(pLC.x, pLC.y + 2, pR.x, pR.y);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  global.FaceMirrorEngine = {
    generateVtuberAvatar,
    createDemoAvatarCanvas,
    FaceMirrorAvatar,
    detectFaceAnchors,
    createDefaultAnchors,
    buildRiggedFaceMesh,
  };
})(window);

