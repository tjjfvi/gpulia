struct Config {
  size: vec2<u32>,
  c: vec4<f32>,
  i: vec4<f32>,
  j: vec4<f32>,
}

@group(0) @binding(0) var<storage, read> config : Config;
@group(0) @binding(1) var<storage, read_write> calc_buf : array<f32>;
@group(0) @binding(2) var<storage, read_write> draw_buf : array<u32>;

@compute @workgroup_size(8, 8)
fn calc(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x + global_id.y * config.size.x;
    let p = config.c + (f32(global_id.x) - f32(config.size.x) / 2.) * config.i + (f32(global_id.y) - f32(config.size.y) / 2.) * config.j;

    let p2 = p * p;

    let c = vec2(p.x, p.y);
    var z = vec2(p.z, p.w);
    var pz = z;
    var z2 = z * z;

    var o = 1.e32;

    for (var i = 0u; i < 1024u; i = i + 1u) {
        z = vec2((z2.x - z2.y), (z.x + z.x) * z.y) + c;
        z2 = z * z;
        if z2.x + z2.y > 16. {
            o = f32(i + 5u) - log2(log2(z2.x + z2.y));
              break;
        } else if i % 16u == 0u {
            pz = z;
        } else {
            let a = abs(z - pz);
            if a.x + a.y < 1.e-32 {
                  break;
            }
        }
    }

    calc_buf[index] = o;
}

@compute @workgroup_size(8, 8)
fn draw(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x + global_id.y * config.size.x;
    let v = calc_buf[index];
    var c = 0.;
    if 0. <= v && v < 1.e31 {
        c = 1 - exp2(-v / 16.);
    }
    draw_buf[index] = pack4x8unorm(vec4f(c, c, c, 1.));
}