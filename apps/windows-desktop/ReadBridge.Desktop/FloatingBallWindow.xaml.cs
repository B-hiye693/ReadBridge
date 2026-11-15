using System.Windows;
using System.Windows.Input;

namespace ReadBridge.Desktop;

public partial class FloatingBallWindow : Window
{
    private readonly Action _restore;
    public FloatingBallWindow(Action restore)
    {
        InitializeComponent();
        _restore = restore;
        var area = SystemParameters.WorkArea;
        Left = area.Right - Width - 24;
        Top = area.Top + (area.Height - Height) / 2;
    }
    private void OnMouseDown(object sender, MouseButtonEventArgs e)
    {
        var left = Left; var top = Top;
        try { DragMove(); } catch (InvalidOperationException) { }
        if (Math.Abs(Left - left) < 4 && Math.Abs(Top - top) < 4) _restore();
    }
}
