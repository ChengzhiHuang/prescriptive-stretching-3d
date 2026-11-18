import * as THREE from 'three';

/** Photograph just the target bundles from the main camera. The visible skin fragment
 * composites that image, so an intervening arm or table retains ordinary depth testing. */
export class MuscleWindowPass {
  readonly scene = new THREE.Scene();
  readonly target = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  private readonly size = new THREE.Vector2(1, 1);
  private readonly clipping: THREE.Vector2;

  constructor(camera: THREE.PerspectiveCamera, lights: THREE.Light[]) {
    this.target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.scene.add(...lights.map(light => light.clone()));
    this.clipping = new THREE.Vector2(camera.near, camera.far);
  }

  configureSkin(material: THREE.MeshStandardMaterial): void {
    material.onBeforeCompile = shader => {
      shader.uniforms.bundleImage = { value: this.target.texture };
      shader.uniforms.bundleDepth = { value: this.target.depthTexture };
      shader.uniforms.bundleSize = { value: this.size };
      shader.uniforms.cameraClip = { value: this.clipping };
      shader.vertexShader = 'attribute float muscleWindow; varying float vWindow;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>', '#include <begin_vertex>\nvWindow = muscleWindow;',
      );
      shader.fragmentShader = `
        uniform sampler2D bundleImage, bundleDepth;
        uniform vec2 bundleSize, cameraClip;
        varying float vWindow;
      ` + shader.fragmentShader.replace('#include <opaque_fragment>', `
        if (vWindow > 0.001) {
          vec2 uv = gl_FragCoord.xy / bundleSize;
          vec4 muscle = texture2D(bundleImage, uv);
          float z = texture2D(bundleDepth, uv).r;
          float depth = cameraClip.x * cameraClip.y / (cameraClip.y - z * (cameraClip.y - cameraClip.x));
          float nearSkin = 1.0 - smoothstep(0.14, 0.25, abs(depth - vViewPosition.z));
          // Keep skin shading between bundles, with a faint warm edge around the window.
          outgoingLight *= mix(vec3(1.0), vec3(1.015, 0.97, 0.95), vWindow);
          outgoingLight = mix(outgoingLight, muscle.rgb, vWindow * muscle.a * nearSkin * 0.98);
        }
        #include <opaque_fragment>
      `);
    };
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    renderer.getDrawingBufferSize(this.size);
    this.target.setSize(this.size.x, this.size.y);
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, camera);
    renderer.setRenderTarget(null);
  }

  dispose(): void {
    this.target.dispose();
  }
}
