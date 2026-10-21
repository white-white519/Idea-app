const THREE = require('three');
const { GLTFLoader, OrbitControls, TransformControls } = require('three-stdlib');
const { FaceMesh } = require('@mediapipe/face_mesh');
const { Camera } = require('@mediapipe/camera_utils');
const fs = require('fs');
const path = require('path');

// Логи
const logFile = path.join(__dirname, 'debug.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    logStream.write(line + '\n');
}
log('=== Приложение запущено ===');

window.onload = () => {
    log('window.onload: начало инициализации');

    const scene = new THREE.Scene();
    const viewport = document.getElementById('canvas-container');
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 10000);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);
    viewport.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(0, 10, 10);
    scene.add(dirLight);

    let model, bones = {}, mixer, actions = {}, activeAction;
    let bgPlane = null;
    const clock = new THREE.Clock();

    const settings = {
        headSmooth: 0.15,
        bodyFollowFactor: 0.25,
        bodySmooth: 0.08,
        eyeSmooth: 0.3,
        eyeMaxAngleH: 0.4,
        eyeMaxAngleV: 0.25,
        headLimitY: 0.9,
        headLimitX: 0.5,
    };

    let initialHeadRot = new THREE.Euler(0, 0, 0, 'YXZ');
    let initialBodyRot = new THREE.Euler(0, 0, 0, 'YXZ');
    let headInitialized = false, bodyInitialized = false;

    let deltaHeadY = 0, deltaHeadX = 0, currentHeadY = 0, currentHeadX = 0;
    let deltaBodyY = 0, deltaBodyX = 0, currentBodyY = 0, currentBodyX = 0;

    let targetEyeRightH = 0, targetEyeRightV = 0, targetEyeLeftH = 0, targetEyeLeftV = 0;
    let currentEyeRightH = 0, currentEyeRightV = 0, currentEyeLeftH = 0, currentEyeLeftV = 0;
    let blinkLeft = 0, blinkRight = 0;

    const equippedAccessories = {};
    const accessoryBones = {
        'sword.glb': 'RightHandItem',
        'hat.glb': 'Head',
        'glasses.glb': 'Face',
        'shield.glb': 'LeftHandItem',
    };

    let transformControls = null;
    let selectedBone = null;

    // UI функции
    window.changeSkinFromFile = (input) => {
        if (input.files && input.files[0]) {
            const url = URL.createObjectURL(input.files[0]);
            applySkinTexture(url);
        }
    };

    window.setSkin = (skinPath) => {
        try {
            const data = fs.readFileSync(skinPath);
            const blob = new Blob([data], { type: 'image/png' });
            const url = URL.createObjectURL(blob);
            applySkinTexture(url);
        } catch (err) { log('Ошибка скина: ' + err); }
    };

    function applySkinTexture(url) {
        new THREE.TextureLoader().load(url, (tex) => {
            tex.magFilter = tex.minFilter = THREE.NearestFilter;
            tex.flipY = false;
            if (model) model.traverse(n => {
                if (n.isMesh) { n.material.map = tex; n.material.needsUpdate = true; }
            });
        });
    }

    window.setBG = (c) => {
        if (bgPlane) { camera.remove(bgPlane); scene.remove(bgPlane); bgPlane = null; }
        if (c === 'transparent') { renderer.setClearAlpha(0); renderer.setClearColor(0x000000); }
        else { renderer.setClearAlpha(1); renderer.setClearColor(c); }
    };

    window.changeCustomBG = (input) => {
        if (!input.files || !input.files[0]) return;
        const url = URL.createObjectURL(input.files[0]);
        new THREE.TextureLoader().load(url, (tex) => {
            if (bgPlane) { camera.remove(bgPlane); scene.remove(bgPlane); }
            const aspect = window.innerWidth / window.innerHeight;
            const geometry = new THREE.PlaneGeometry(2 * aspect, 2);
            const material = new THREE.MeshBasicMaterial({ map: tex, depthTest: false, depthWrite: false });
            bgPlane = new THREE.Mesh(geometry, material);
            bgPlane.position.set(0, 0, -2);
            camera.add(bgPlane);
            scene.add(camera);
            renderer.setClearAlpha(1);
            renderer.setClearColor(0x000000);
        });
    };

    window.filterPoses = (query) => {
        document.querySelectorAll('#poses-container .pose-btn').forEach(btn => {
            btn.style.display = btn.textContent.toLowerCase().includes(query.toLowerCase()) ? '' : 'none';
        });
    };

    window.toggleAccessory = (fileName, fullPath) => {
        if (equippedAccessories[fileName]) {
            const acc = equippedAccessories[fileName];
            (acc.boneObj || scene).remove(acc.object);
            delete equippedAccessories[fileName];
            updateAccessoryUI();
        } else {
            new GLTFLoader().load(fullPath, (gltf) => {
                const accModel = gltf.scene;
                const boneName = accessoryBones[fileName];
                if (boneName && bones[boneName]) {
                    bones[boneName].add(accModel);
                    equippedAccessories[fileName] = { object: accModel, boneObj: bones[boneName] };
                } else {
                    scene.add(accModel);
                    equippedAccessories[fileName] = { object: accModel, boneObj: null };
                }
                updateAccessoryUI();
            });
        }
    };

    function updateAccessoryUI() {
        document.querySelectorAll('.accessory-thumb').forEach(thumb => {
            thumb.classList.toggle('equipped', !!equippedAccessories[thumb.dataset.filename]);
        });
    }

    // Кости и gizmo
    function populateBonesList() {
        const listEl = document.getElementById('bones-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        Object.keys(bones).forEach(name => {
            const btn = document.createElement('button');
            btn.className = 'bone-btn';
            btn.textContent = name;
            btn.onclick = () => selectBone(name, btn);
            listEl.appendChild(btn);
        });
    }

    function selectBone(name, btnElement) {
        if (!transformControls || !bones[name]) return;
        deselectBone();
        selectedBone = name;
        transformControls.attach(bones[name]);
        if (btnElement) btnElement.classList.add('selected');
    }

    window.deselectBone = function() {
        if (transformControls) transformControls.detach();
        document.querySelectorAll('.bone-btn').forEach(b => b.classList.remove('selected'));
        selectedBone = null;
    };

    function setupGizmoModeButtons() {
        const btnTranslate = document.getElementById('mode-translate');
        const btnRotate = document.getElementById('mode-rotate');
        if (!btnTranslate || !btnRotate) {
            log('Кнопки gizmo не найдены (старый HTML?)');
            return;
        }
        btnTranslate.addEventListener('click', () => {
            if (transformControls) transformControls.setMode('translate');
            btnTranslate.classList.add('active');
            btnRotate.classList.remove('active');
        });
        btnRotate.addEventListener('click', () => {
            if (transformControls) transformControls.setMode('rotate');
            btnRotate.classList.add('active');
            btnTranslate.classList.remove('active');
        });
    }

    // Загрузка модели
    const loader = new GLTFLoader();
    loader.load('./models/avatar.glb', (gltf) => {
        model = gltf.scene;
        scene.add(model);
        model.rotation.y = Math.PI;

        const boneList = [];
        model.traverse(n => {
            if (n.isBone) {
                bones[n.name] = n;
                boneList.push(n.name);
            }
            if (n.isMesh) { n.material.alphaTest = 0.5; n.material.transparent = true; }
        });

        log(`Кости (${boneList.length}): ${boneList.join(', ')}`);

        if (bones['Head']) {
            initialHeadRot.copy(bones['Head'].rotation);
            headInitialized = true;
        }
        bones.body = bones['Body'] || bones['Spine'] || bones['body'] || null;
        if (bones.body) {
            initialBodyRot.copy(bones.body.rotation);
            bodyInitialized = true;
        }

        populateBonesList();

        if (gltf.animations && gltf.animations.length > 0) {
            mixer = new THREE.AnimationMixer(model);
            const container = document.getElementById('poses-container');
            container.innerHTML = '';
            gltf.animations.forEach(clip => {
                if (clip.name.includes('---') || clip.name === 'blinking') return;
                actions[clip.name] = mixer.clipAction(clip);
                const btn = document.createElement('button');
                btn.className = 'pose-btn';
                btn.innerText = clip.name;
                btn.onclick = () => {
                    if (activeAction) activeAction.fadeOut(0.3);
                    activeAction = actions[clip.name].reset().fadeIn(0.3).play();
                };
                container.appendChild(btn);
            });
        }

        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        camera.position.set(0, center.y, size.y * 2.2);
        controls.target.copy(center);
        controls.update();
    });

    // Гардероб и аксессуары
    function loadWardrobe() {
        const grid = document.getElementById('skin-grid');
        if (!grid) return;
        const skinsDir = path.join(__dirname, 'skins');
        if (!fs.existsSync(skinsDir)) return;
        const files = fs.readdirSync(skinsDir).filter(f => f.endsWith('.png'));
        grid.innerHTML = '';
        files.forEach(file => {
            const fullPath = path.join(skinsDir, file);
            const data = fs.readFileSync(fullPath);
            const blob = new Blob([data], { type: 'image/png' });
            const img = document.createElement('img');
            img.src = URL.createObjectURL(blob);
            img.className = 'skin-thumb';
            img.title = file;
            img.onclick = () => window.setSkin(fullPath);
            grid.appendChild(img);
        });
    }

    function loadAccessories() {
        const grid = document.getElementById('accessory-grid');
        if (!grid) return;
        const accDir = path.join(__dirname, 'accessories');
        if (!fs.existsSync(accDir)) return;
        const files = fs.readdirSync(accDir).filter(f => f.endsWith('.glb'));
        grid.innerHTML = '';
        files.forEach(file => {
            const div = document.createElement('div');
            div.className = 'accessory-thumb';
            div.dataset.filename = file;
            div.textContent = file.replace('.glb', '');
            div.onclick = () => window.toggleAccessory(file, path.join(accDir, file));
            grid.appendChild(div);
        });
    }

    setTimeout(() => { loadWardrobe(); loadAccessories(); }, 0);

    // Gizmo
    transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode('translate');
    transformControls.addEventListener('dragging-changed', (event) => {
        controls.enabled = !event.value;
    });
    scene.add(transformControls);
    setupGizmoModeButtons();

    // Face Mesh
    const faceMesh = new FaceMesh({
        locateFile: (file) => `./node_modules/@mediapipe/face_mesh/${file}`
    });
    faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true });

    faceMesh.onResults((res) => {
        if (!res.multiFaceLandmarks?.length) return;
        const p = res.multiFaceLandmarks[0];

        const dx = p[4].x - 0.5;
        const dy = p[4].y - 0.5;
        deltaHeadY = THREE.MathUtils.clamp(-dx * 1.5, -settings.headLimitY, settings.headLimitY);
        deltaHeadX = THREE.MathUtils.clamp(dy * 1.2, -settings.headLimitX, settings.headLimitX);

        blinkLeft = THREE.MathUtils.lerp(blinkLeft, Math.abs(p[159].y - p[145].y) < 0.018 ? 1 : 0, 0.4);
        blinkRight = THREE.MathUtils.lerp(blinkRight, Math.abs(p[386].y - p[374].y) < 0.018 ? 1 : 0, 0.4);

        const leftGazeH = THREE.MathUtils.clamp((p[468].x - (p[33].x + p[133].x) / 2) / ((p[133].x - p[33].x) * 0.5), -1, 1);
        const leftGazeV = THREE.MathUtils.clamp((p[468].y - (p[159].y + p[145].y) / 2) / ((p[159].y - p[145].y || 0.01) * 0.5), -1, 1);
        targetEyeLeftH = leftGazeH * settings.eyeMaxAngleH;
        targetEyeLeftV = leftGazeV * settings.eyeMaxAngleV;

        const rightGazeH = THREE.MathUtils.clamp((p[473].x - (p[362].x + p[263].x) / 2) / ((p[263].x - p[362].x) * 0.5), -1, 1);
        const rightGazeV = THREE.MathUtils.clamp((p[473].y - (p[386].y + p[374].y) / 2) / ((p[386].y - p[374].y || 0.01) * 0.5), -1, 1);
        targetEyeRightH = rightGazeH * settings.eyeMaxAngleH;
        targetEyeRightV = rightGazeV * settings.eyeMaxAngleV;

        deltaBodyY = deltaHeadY * settings.bodyFollowFactor;
        deltaBodyX = deltaHeadX * settings.bodyFollowFactor * 0.5;
    });

    const video = document.getElementById('input-video');
    new Camera(video, {
        onFrame: async () => { try { await faceMesh.send({ image: video }); } catch(e) {} },
        width: 640, height: 480
    }).start();

    // Вкладки
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        });
    });

    // Анимация
    function animate() {
        requestAnimationFrame(animate);
        if (mixer) mixer.update(clock.getDelta());
        controls.update();

        if (model) {
            if (headInitialized && bones['Head']) {
                currentHeadY += (deltaHeadY - currentHeadY) * settings.headSmooth;
                currentHeadX += (deltaHeadX - currentHeadX) * settings.headSmooth;
                bones['Head'].rotation.copy(initialHeadRot);
                bones['Head'].rotateY(currentHeadY);
                bones['Head'].rotateX(currentHeadX);
            }

            const s = 0.5, zOff = 0.35;
            if (bones['LeftUp']) { bones['LeftUp'].position.y = -blinkLeft * s; bones['LeftUp'].position.z = zOff; }
            if (bones['LeftDown']) { bones['LeftDown'].position.y = blinkLeft * s; bones['LeftDown'].position.z = zOff; }
            if (bones['RightUp']) { bones['RightUp'].position.y = -blinkRight * s; bones['RightUp'].position.z = zOff; }
            if (bones['RightDown']) { bones['RightDown'].position.y = blinkRight * s; bones['RightDown'].position.z = zOff; }

            if (bones['LeftEye']) {
                currentEyeLeftH += (targetEyeLeftH - currentEyeLeftH) * settings.eyeSmooth;
                currentEyeLeftV += (targetEyeLeftV - currentEyeLeftV) * settings.eyeSmooth;
                bones['LeftEye'].rotation.y = currentEyeLeftH;
                bones['LeftEye'].rotation.x = currentEyeLeftV;
            }
            if (bones['RightEye']) {
                currentEyeRightH += (targetEyeRightH - currentEyeRightH) * settings.eyeSmooth;
                currentEyeRightV += (targetEyeRightV - currentEyeRightV) * settings.eyeSmooth;
                bones['RightEye'].rotation.y = currentEyeRightH;
                bones['RightEye'].rotation.x = currentEyeRightV;
            }

            if (bodyInitialized && bones.body) {
                currentBodyY += (deltaBodyY - currentBodyY) * settings.bodySmooth;
                currentBodyX += (deltaBodyX - currentBodyX) * settings.bodySmooth;
                bones.body.rotation.copy(initialBodyRot);
                bones.body.rotateY(currentBodyY);
                bones.body.rotateX(currentBodyX);
            }
        }

        renderer.render(scene, camera);
    }
    animate();
};