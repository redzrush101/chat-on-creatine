{
  description = "Chat on Creatine development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [ nodejs_24 electron_44 python3 gcc gnumake pkg-config ripgrep git xvfb-run ];
            # Run the nixpkgs Electron instead of the npm-downloaded binary (which cannot run on NixOS).
            ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
            ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron_44}/libexec/electron";
          };
        });
    };
}
